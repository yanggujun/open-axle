# Open Axle

Open Axle is a simple but effective CLI AI agent for software developers. 

If you are an expert in other domain, you can also simply replace and add skills according to your requirement.

The built-in skills are all used to operate on file system and network.

The agent is well tested with deepseek-v4-flash.

## Requirements

- Python 3.13 or newer
- An API key for an OpenAI-compatible endpoint

## Installation

Checkout the code into local

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python ./axle.py
```

## Configuration

Copy `.env.sample` to `.env` and set the required environment variables:

- `API_KEY` — your API key (required)
- `BASE_URL` — API base URL (e.g., `https://api.openai.com/v1/chat/completions`)
- `MODEL_NAME` — model identifier to use
- `SKILLS_FOLDER` — path to the skills folder (default: `skills`)
- `RESPONSES_API` — set to `TRUE` to use the Responses API

Copy `.axle.sample` to `.axle` to configure skill-specific settings (database connections, API auth, etc.).

## Commands

- Type your message to chat with the agent
- `skills` — list all loaded skills
- `set pwd <path>` — set the default working directory
- `reload` — reload skills and reset conversation
- `clear` — clear conversation history
- `quit`, `exit`, or `q` — exit the agent

### Sample Prompt

 - Find method "aComplexMethod", explain the usage of parameter "abc".
 - SSH to "myRemoteServer", in folder $HOME/Downloads, find file *abc.tar.gz, and extract the content into folder abc
 - From database "myDevDB", get the first 10 records of table "PERSON" order by ID descending, and save the content into person.csv in csv format
 - CURL to API "https://mydomain.com/rest/some/api", analyse the result to find some data.

Configuration in .axle file in the same directory

``` JSON

{
    "skill_configs": [
        {
            "skill": "access_db",
            "config_items": [
                {
                    "name": "myDevDB",
                    "value": {
                        "port": "50000",
                        "address": "db address",
                        "user_name": "user",
                        "pass": "password",
                        "type": "mysql",
                        "driver": "db_driver"
                      }
                }
            ]
        },
        {
            "skill": "curl",
            "config_items": [
                {
                    "name": "mydomain",
                    "value": {
                            "auth_string": "bearer xxxx"
                    }
                }
            ]
        },
        {
            "skill": "ssh",
            "config_items": [
                {
                    "name": "devserver",
                    "value": {
                        "host": "host address",
                        "port": "22",
                        "user_name": "login user",
                        "auth_type": "key",
                        "key_file": "your ssh connection key file"
                    }
                }
            ]
        }
    ]
}
```


## Skills Folder Structure

Each skill is a subdirectory of `skills/` containing a `SKILL.md` file:

```
skills/
  my-skill/
    SKILL.md
    skill_code.py
```

The `SKILL.md` file is used as context for the LLM. Python files with `@AxleExecutor` decorated functions are discoverable as executable skills.
