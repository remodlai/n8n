import { NodeConnectionTypes } from 'n8n-workflow';
import type {
	INodeInputConfiguration,
	INodeInputFilter,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
	INodeTypeBaseDescription,
} from 'n8n-workflow';

import { promptTypeOptions, textFromPreviousNode, textInput } from '@utils/descriptions';

import { toolsAgentProperties } from '../agents/ToolsAgent/V2/description';
import { toolsAgentExecute } from '../agents/ToolsAgent/V2/execute';

// Function used in the inputs expression to figure out which inputs to
// display based on the agent type
function getInputs(
	hasOutputParser?: boolean,
	needsFallback?: boolean,
	enableFillerStreaming?: boolean,
): Array<NodeConnectionType | INodeInputConfiguration> {
	interface SpecialInput {
		type: NodeConnectionType;
		filter?: INodeInputFilter;
		displayName: string;
		required?: boolean;
	}

	const getInputData = (
		inputs: SpecialInput[],
	): Array<NodeConnectionType | INodeInputConfiguration> => {
		return inputs.map(({ type, filter, displayName, required }) => {
			const input: INodeInputConfiguration = {
				type,
				displayName,
				required,
				maxConnections: ['ai_languageModel', 'ai_memory', 'ai_outputParser'].includes(type)
					? 1
					: undefined,
			};

			if (filter) {
				input.filter = filter;
			}

			return input;
		});
	};

	let specialInputs: SpecialInput[] = [
		{
			type: 'ai_languageModel',
			displayName: 'Chat Model',
			required: true,
			filter: {
				excludedNodes: [
					'@n8n/n8n-nodes-langchain.lmCohere',
					'@n8n/n8n-nodes-langchain.lmOllama',
					'n8n/n8n-nodes-langchain.lmOpenAi',
					'@n8n/n8n-nodes-langchain.lmOpenHuggingFaceInference',
				],
			},
		},
		{
			type: 'ai_languageModel',
			displayName: 'Fallback Model',
			required: true,
			filter: {
				excludedNodes: [
					'@n8n/n8n-nodes-langchain.lmCohere',
					'@n8n/n8n-nodes-langchain.lmOllama',
					'n8n/n8n-nodes-langchain.lmOpenAi',
					'@n8n/n8n-nodes-langchain.lmOpenHuggingFaceInference',
				],
			},
		},
		{
			type: 'ai_languageModel',
			displayName: 'Filler Model',
			required: false,
			filter: {
				excludedNodes: [
					'@n8n/n8n-nodes-langchain.lmCohere',
					'@n8n/n8n-nodes-langchain.lmOllama',
					'n8n/n8n-nodes-langchain.lmOpenAi',
					'@n8n/n8n-nodes-langchain.lmOpenHuggingFaceInference',
				],
			},
		},
		{
			displayName: 'Memory',
			type: 'ai_memory',
		},
		{
			displayName: 'Tool',
			type: 'ai_tool',
		},
		{
			displayName: 'Output Parser',
			type: 'ai_outputParser',
		},
	];

	if (hasOutputParser === false) {
		specialInputs = specialInputs.filter((input) => input.type !== 'ai_outputParser');
	}
	if (needsFallback === false) {
		specialInputs = specialInputs.filter((input) => input.displayName !== 'Fallback Model');
	}
	if (enableFillerStreaming === false) {
		specialInputs = specialInputs.filter((input) => input.displayName !== 'Filler Model');
	}
	return ['main', ...getInputData(specialInputs)];
}

export class AgentV2 implements INodeType {
	description: INodeTypeDescription;

	constructor(baseDescription: INodeTypeBaseDescription) {
		this.description = {
			...baseDescription,
			version: [2, 2.1, 2.2],
			defaults: {
				name: 'AI Agent',
				color: '#404040',
			},
			inputs: `={{
				((hasOutputParser, needsFallback, enableFillerStreaming) => {
					${getInputs.toString()};
					return getInputs(hasOutputParser, needsFallback, enableFillerStreaming)
				})($parameter.hasOutputParser === undefined || $parameter.hasOutputParser === true, $parameter.needsFallback === undefined || $parameter.needsFallback === true, $parameter.enableFillerStreaming === true)
			}}`,
			outputs: [NodeConnectionTypes.Main],
			properties: [
				{
					displayName:
						'Tip: Get a feel for agents with our quick <a href="https://docs.n8n.io/advanced-ai/intro-tutorial/" target="_blank">tutorial</a> or see an <a href="/workflows/templates/1954" target="_blank">example</a> of how this node works',
					name: 'aiAgentStarterCallout',
					type: 'callout',
					default: '',
				},
				promptTypeOptions,
				{
					...textFromPreviousNode,
					displayOptions: {
						show: {
							promptType: ['auto'],
						},
					},
				},
				{
					...textInput,
					displayOptions: {
						show: {
							promptType: ['define'],
						},
					},
				},
				{
					displayName: 'Require Specific Output Format',
					name: 'hasOutputParser',
					type: 'boolean',
					default: false,
					noDataExpression: true,
					displayOptions: {
						show: {
							'@version': [{ _cnd: { gte: 2.1 } }],
						},
					},
				},
				{
					displayName: `Connect an <a data-action='openSelectiveNodeCreator' data-action-parameter-connectiontype='${NodeConnectionTypes.AiOutputParser}'>output parser</a> on the canvas to specify the output format you require`,
					name: 'notice',
					type: 'notice',
					default: '',
					displayOptions: {
						show: {
							hasOutputParser: [true],
						},
					},
				},
				{
					displayName: 'Enable Fallback Model',
					name: 'needsFallback',
					type: 'boolean',
					default: false,
					noDataExpression: true,
					displayOptions: {
						show: {
							'@version': [{ _cnd: { gte: 2.1 } }],
						},
					},
				},
				{
					displayName:
						'Connect an additional language model on the canvas to use it as a fallback if the main model fails',
					name: 'fallbackNotice',
					type: 'notice',
					default: '',
					displayOptions: {
						show: {
							needsFallback: [true],
						},
					},
				},
				{
					displayName: 'Enable Streaming',
					name: 'enableStreaming',
					type: 'boolean',
					default: false,
					description:
						'Whether this agent will stream the response in real-time as it generates text',
					displayOptions: {
						hide: {
							'@version': [{ _cnd: { lt: 2.2 } }],
						},
					},
				},
				{
					displayName: 'Enable Filler Streaming',
					name: 'enableFillerStreaming',
					type: 'boolean',
					default: false,
					description: 'Stream filler responses while the main agent is processing',
					displayOptions: {
						show: {
							enableStreaming: [true],
							'@version': [{ _cnd: { gte: 2.2 } }],
						},
					},
				},
				{
					displayName:
						'Connect a fast language model to provide immediate responses while the main agent processes',
					name: 'fillerNotice',
					type: 'notice',
					default: '',
					displayOptions: {
						show: {
							enableFillerStreaming: [true],
						},
					},
				},
				{
					displayName: 'Filler System Message',
					name: 'fillerSystemMessage',
					type: 'string',
					default:
						"You are a helpful assistant. Provide a brief acknowledgment or thinking message while processing the user's request. Keep it natural and conversational.",
					typeOptions: {
						rows: 4,
					},
					displayOptions: {
						show: {
							enableFillerStreaming: [true],
						},
					},
					description: 'System message for the filler model',
				},
				{
					displayName: 'Filler User Prompt',
					name: 'fillerUserPrompt',
					type: 'string',
					default:
						'The user asked: "{{$json.input}}". Briefly acknowledge their request while I process it.',
					typeOptions: {
						rows: 3,
					},
					displayOptions: {
						show: {
							enableFillerStreaming: [true],
						},
					},
					description: 'Dynamic prompt template for the filler model. Supports expressions.',
				},
				{
					displayName: 'Stream Intermediate Steps',
					name: 'streamIntermediateSteps',
					type: 'boolean',
					default: false,
					description: 'Stream agent tool calls and thinking steps as events',
					displayOptions: {
						show: {
							enableStreaming: [true],
							'@version': [{ _cnd: { gte: 2.2 } }],
						},
					},
				},
				...toolsAgentProperties,
			],
			hints: [
				{
					message:
						'You are using streaming responses. Make sure to set the response mode to "Streaming Response" on the connected trigger node.',
					type: 'warning',
					location: 'outputPane',
					whenToDisplay: 'afterExecution',
					displayCondition: '={{ $parameter["enableStreaming"] === true }}',
				},
			],
		};
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return await toolsAgentExecute.call(this);
	}
}
