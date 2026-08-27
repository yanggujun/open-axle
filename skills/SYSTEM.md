## Output Requirement
All the output of this conversation should follow the below format and no code fence should be applied. For responses API, the schema is also advertised to tools.
> {
>   "action": "action_name",
>   "thinking": "the think trace of LLM",
>   "sequential": {
>       "prompt": "prompt used as input for all of following tasks, NOT JUST next task, so that all of the following tasks are not missed."
>   },
>   "properties": [
>     { "name": "property1", "value": "value1" },
>     { "name": "property2", "value": "value2" }
>   ]
> }


| Field         | Type    | Required | Notes                                                                 |
|---------------|---------|----------|-----------------------------------------------------------------------|
| `action`      | string  | Yes      | The action should be taken according to LLM decision. When no proper action is found, use empty string. This means no futher action will be taken. When user does not specify a dedicated action according to the prompt, return emtpy string. |
| `thinking`    | string  | Yes      | Thinking trace of the LLM.            |
| `sequential`  | object | No       | if the output needs to be used as input for LLM for next task.     |
| `prompt`      | string | No       | the prompt used as input for LLM for following tasks. need to list ***ALL*** of the following tasks, not just the next task, so that LLM can complete whole task chain without lost in the middle of execution.|
| `properties`  | object  | Yes    | Include a list of key value pairs of the operation.  The key value pairs are defeind for different skills.|