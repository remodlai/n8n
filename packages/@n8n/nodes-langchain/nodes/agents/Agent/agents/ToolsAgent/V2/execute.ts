import type { StreamEvent } from '@langchain/core/dist/tracers/event_stream';
import type { IterableReadableStream } from '@langchain/core/dist/utils/stream';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk, MessageContentText } from '@langchain/core/messages';
import type { ChatPromptTemplate } from '@langchain/core/prompts';
import { RunnableSequence } from '@langchain/core/runnables';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import type { BaseChatMemory } from 'langchain/memory';
import type { DynamicStructuredTool, Tool } from 'langchain/tools';
import omit from 'lodash/omit';
import { jsonParse, NodeOperationError, sleep } from 'n8n-workflow';
import type { IExecuteFunctions, INodeExecutionData, IDataObject } from 'n8n-workflow';
import assert from 'node:assert';

import { getPromptInputByType } from '@utils/helpers';
import {
	getOptionalOutputParser,
	type N8nOutputParser,
} from '@utils/output_parsers/N8nOutputParser';

import {
	fixEmptyContentMessage,
	getAgentStepsParser,
	getChatModel,
	getOptionalMemory,
	getTools,
	prepareMessages,
	preparePrompt,
} from '../common';
import { SYSTEM_MESSAGE } from '../prompt';

/**
 * Creates an agent executor with the given configuration
 */
function createAgentExecutor(
	model: BaseChatModel,
	tools: Array<DynamicStructuredTool | Tool>,
	prompt: ChatPromptTemplate,
	options: { maxIterations?: number; returnIntermediateSteps?: boolean },
	outputParser?: N8nOutputParser,
	memory?: BaseChatMemory,
	fallbackModel?: BaseChatModel | null,
) {
	const modelWithFallback = fallbackModel ? model.withFallbacks([fallbackModel]) : model;
	const agent = createToolCallingAgent({
		llm: modelWithFallback,
		tools,
		prompt,
		streamRunnable: false,
	});

	const runnableAgent = RunnableSequence.from([
		agent,
		getAgentStepsParser(outputParser, memory),
		fixEmptyContentMessage,
	]);

	return AgentExecutor.fromAgentAndTools({
		agent: runnableAgent,
		memory,
		tools,
		returnIntermediateSteps: options.returnIntermediateSteps === true,
		maxIterations: options.maxIterations ?? 10,
	});
}

async function processEventStream(
	ctx: IExecuteFunctions,
	eventStream: IterableReadableStream<StreamEvent>,
	fillerModel?: BaseChatModel,
	fillerPrompt?: string,
	streamIntermediateSteps?: boolean,
): Promise<any> {
	const fullResponse: any = {
		output: '',
		intermediate_steps: [],
	};

	let mainStreamBuffer: string[] = [];
	let bufferCount = 0;
	let fillerComplete = false;
	let switchedToMain = false;

	// Start with begin event
	ctx.sendChunk('begin');

	// If we have a filler model, start streaming filler content
	if (fillerModel && fillerPrompt) {
		try {
			const fillerStream = await fillerModel.stream(fillerPrompt);
			let fillerContent = '';

			// Send filler content as a complete chunk, not token by token
			for await (const chunk of fillerStream) {
				fillerContent += chunk.content;
			}

			if (fillerContent && !switchedToMain) {
				// Send filler as a custom event
				ctx.sendChunk('item', {
					type: 'filler',
					content: fillerContent,
				});
			}
			fillerComplete = true;
		} catch (error) {
			console.error('Filler model error:', error);
			fillerComplete = true;
		}
	}

	// Process main event stream
	for await (const event of eventStream) {
		if (event.event === 'on_llm_stream' && event.data?.chunk) {
			const messageChunk = event.data.chunk as AIMessageChunk;

			if (messageChunk.content) {
				// Handle different content types
				let contentText = '';
				if (typeof messageChunk.content === 'string') {
					contentText = messageChunk.content;
				} else if (Array.isArray(messageChunk.content)) {
					// Handle MessageContentComplex[] - extract text content
					contentText = messageChunk.content
						.map((item: any) => {
							if (typeof item === 'string') return item;
							if (item.type === 'text' && item.text) return item.text;
							return '';
						})
						.join('');
				}

				fullResponse.output += contentText;

				// Buffer first 10 chunks
				if (bufferCount < 10) {
					mainStreamBuffer.push(contentText);
					bufferCount++;
				} else {
					// After buffering, switch to main stream
					if (!switchedToMain) {
						switchedToMain = true;
						// Send all buffered content at once
						ctx.sendChunk('item', mainStreamBuffer.join(''));
						mainStreamBuffer = [];
					}
					// Continue streaming main content
					ctx.sendChunk('item', contentText);
				}
			}
		} else if (event.event === 'on_tool_start') {
			// Stream intermediate steps as events
			if (streamIntermediateSteps) {
				ctx.sendChunk('item', {
					type: 'intermediate_step',
					tool: event.name,
					input: event.data?.input,
				});
			}

			// Collect for final response
			fullResponse.intermediate_steps.push({
				tool: event.name,
				input: event.data?.input,
			});
		} else if (event.event === 'on_tool_end') {
			// Stream tool results
			if (streamIntermediateSteps) {
				ctx.sendChunk('item', {
					type: 'intermediate_step',
					tool: event.name,
					output: event.data?.output,
				});
			}

			// Update intermediate steps with output
			const lastStep = fullResponse.intermediate_steps[fullResponse.intermediate_steps.length - 1];
			if (lastStep && lastStep.tool === event.name) {
				lastStep.output = event.data?.output;
			}
		}
	}

	// If we still have buffered content and haven't switched, send it now
	if (mainStreamBuffer.length > 0 && !switchedToMain) {
		ctx.sendChunk('item', mainStreamBuffer.join(''));
	}

	// End the stream
	ctx.sendChunk('end');

	// Return the full response object as in non-streaming mode
	return fullResponse;
}

/* -----------------------------------------------------------
   Main Executor Function
----------------------------------------------------------- */
/**
 * The main executor method for the Tools Agent.
 *
 * This function retrieves necessary components (model, memory, tools), prepares the prompt,
 * creates the agent, and processes each input item. The error handling for each item is also
 * managed here based on the node's continueOnFail setting.
 *
 * @returns The array of execution data for all processed items
 */
export async function toolsAgentExecute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
	this.logger.debug('Executing Tools Agent V2');

	const returnData: INodeExecutionData[] = [];
	const items = this.getInputData();
	const batchSize = this.getNodeParameter('options.batching.batchSize', 0, 1) as number;
	const delayBetweenBatches = this.getNodeParameter(
		'options.batching.delayBetweenBatches',
		0,
		0,
	) as number;
	const needsFallback = this.getNodeParameter('needsFallback', 0, false) as boolean;
	const memory = await getOptionalMemory(this);
	const model = await getChatModel(this, 0);
	assert(model, 'Please connect a model to the Chat Model input');
	const fallbackModel = needsFallback ? await getChatModel(this, 1) : null;

	if (needsFallback && !fallbackModel) {
		throw new NodeOperationError(
			this.getNode(),
			'Please connect a model to the Fallback Model input or disable the fallback option',
		);
	}

	// Check if streaming is enabled
	const enableStreaming = this.getNodeParameter('enableStreaming', 0, false) as boolean;
	const enableFillerStreaming = this.getNodeParameter('enableFillerStreaming', 0, false) as boolean;
	const streamIntermediateSteps = this.getNodeParameter(
		'streamIntermediateSteps',
		0,
		false,
	) as boolean;

	// Get filler model if enabled
	let fillerModel: BaseChatModel | undefined;
	if (enableStreaming && enableFillerStreaming) {
		// Get the third model input (index 2) for filler
		fillerModel = await getChatModel(this, 2);
	}

	for (let i = 0; i < items.length; i += batchSize) {
		const batch = items.slice(i, i + batchSize);
		const batchPromises = batch.map(async (_item, batchItemIndex) => {
			const itemIndex = i + batchItemIndex;

			const input = getPromptInputByType({
				ctx: this,
				i: itemIndex,
				inputKey: 'text',
				promptTypeKey: 'promptType',
			});
			if (input === undefined) {
				throw new NodeOperationError(this.getNode(), 'The "text" parameter is empty.');
			}
			const outputParser = await getOptionalOutputParser(this, itemIndex);
			const tools = await getTools(this, outputParser);
			const options = this.getNodeParameter('options', itemIndex, {}) as {
				systemMessage?: string;
				maxIterations?: number;
				returnIntermediateSteps?: boolean;
				passthroughBinaryImages?: boolean;
			};

			// Prepare the prompt messages and prompt template.
			const messages = await prepareMessages(this, itemIndex, {
				systemMessage: options.systemMessage,
				passthroughBinaryImages: options.passthroughBinaryImages ?? true,
				outputParser,
			});
			const prompt: ChatPromptTemplate = preparePrompt(messages);

			// Create executors for primary and fallback models
			const executor = createAgentExecutor(
				model,
				tools,
				prompt,
				options,
				outputParser,
				memory,
				fallbackModel,
			);
			// Invoke with fallback logic
			const invokeParams = {
				input,
				system_message: options.systemMessage ?? SYSTEM_MESSAGE,
				formatting_instructions:
					'IMPORTANT: For your response to user, you MUST use the `format_final_json_response` tool with your complete answer formatted according to the required schema. Do not attempt to format the JSON manually - always use this tool. Your response will be rejected if it is not properly formatted through this tool. Only use this tool once you are ready to provide your final answer.',
			};
			const executeOptions = { signal: this.getExecutionCancelSignal() };

			if (enableStreaming) {
				const eventStream = executor.streamEvents(invokeParams, {
					version: 'v2',
					...executeOptions,
				});

				// Prepare filler prompt if enabled
				let fillerPrompt = '';
				if (fillerModel && enableFillerStreaming) {
					const fillerSystemMessage = this.getNodeParameter(
						'fillerSystemMessage',
						itemIndex,
						'',
					) as string;
					const fillerUserPromptTemplate = this.getNodeParameter(
						'fillerUserPrompt',
						itemIndex,
						'',
					) as string;

					// Process the filler user prompt as an expression
					const fillerUserPrompt = this.evaluateExpression(
						fillerUserPromptTemplate,
						itemIndex,
					) as string;

					// Combine system and user messages for filler
					fillerPrompt = `${fillerSystemMessage}\n\nUser: ${fillerUserPrompt}`;
				}

				return await processEventStream(
					this,
					eventStream,
					fillerModel,
					fillerPrompt,
					streamIntermediateSteps,
				);
			} else {
				// Handle regular execution
				return await executor.invoke(invokeParams, executeOptions);
			}
		});

		const batchResults = await Promise.allSettled(batchPromises);
		// This is only used to check if the output parser is connected
		// so we can parse the output if needed. Actual output parsing is done in the loop above
		const outputParser = await getOptionalOutputParser(this, 0);
		batchResults.forEach((result, index) => {
			const itemIndex = i + index;
			if (result.status === 'rejected') {
				const error = result.reason as Error;
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error.message },
						pairedItem: { item: itemIndex },
					});
					return;
				} else {
					throw new NodeOperationError(this.getNode(), error);
				}
			}
			const response = result.value;
			// If memory and outputParser are connected, parse the output.
			if (memory && outputParser) {
				const parsedOutput = jsonParse<{ output: Record<string, unknown> }>(
					response.output as string,
				);
				response.output = parsedOutput?.output ?? parsedOutput;
			}

			// Omit internal keys before returning the result.
			const itemResult = {
				json: omit(
					response,
					'system_message',
					'formatting_instructions',
					'input',
					'chat_history',
					'agent_scratchpad',
				),
				pairedItem: { item: itemIndex },
			};

			returnData.push(itemResult);
		});

		if (i + batchSize < items.length && delayBetweenBatches > 0) {
			await sleep(delayBetweenBatches);
		}
	}

	return [returnData];
}
