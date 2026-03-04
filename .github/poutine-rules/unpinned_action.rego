package github.workflows

import future.keywords.in

# Returns true if a GitHub Action is pinned to a commit sha
is_sha_pinned(uses) {
    # Check for a full 40-character SHA or abbreviated SHA (at least 7 chars)
    count(regex.find_n(`@[0-9a-f]{40}$`, uses, 1)) > 0
}

is_sha_pinned(uses) {
    # Check for abbreviated SHA (at least 7 characters)
    count(regex.find_n(`@[0-9a-f]{7,39}$`, uses, 1)) > 0
}

# Returns true if an action is a local action (uses: "./" or "./action")
is_local_action(uses) {
    startswith(uses, "./")
}

# Returns true if the step references a reusable workflow
is_reusable_workflow(uses) {
    contains(uses, ".github/workflows/")
}

# Detect GitHub workflow files
workflows contains input.path {
    input.path == glob.match(".github/workflows/*.{yml,yaml}", [input.path])
}

# Find steps that use unpinned actions (not SHA pinned, not local actions, and not reusable workflows)
results[{
    "message": "Action not pinned to SHA: " + step.uses,
    "snippet": step,
    "filepath": input.path
}] {
    workflow := yaml.unmarshal(input.content)
    job_id := jobs[_]
    job := workflow.jobs[job_id]
    step := job.steps[_]
    step.uses
    not is_sha_pinned(step.uses)
    not is_local_action(step.uses)
    not is_reusable_workflow(step.uses)
}

# Get a list of all jobs defined in the workflow
jobs[job_id] {
    workflow := yaml.unmarshal(input.content)
    job_id := object.keys(workflow.jobs)[_]
}