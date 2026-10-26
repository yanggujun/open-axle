# Open Axle

Open Axle is a simple but effective agent for software developers. 

If you are an expert in other domain, you can also simply replace and add skills according to your requirement.

The built-in skills are all used to operate on file system and network.

The agent is well tested with deepseek-v4-flash.

## Requirements

- nodejs
- An API key for an OpenAI-compatible endpoint

## Installation

Checkout the code into local

### Start GUI
```bash
npm install
npm run build
npm start
```

## Sample Prompt

 - Find method "aComplexMethod", explain the usage of parameter "abc".
 - SSH to "myRemoteServer", in folder $HOME/Downloads, find file *abc.tar.gz, and extract the content into folder abc
 - From database "myDevDB", get the first 10 records of table "PERSON" order by ID descending, and save the content into person.csv in csv format
 - CURL to API "https://mydomain.com/rest/some/api", analyse the result to find some data.

Configures SKILLs configurations in .axle folder in the user home:

.skill.config
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
                    "name": "myRemoteServer",
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
    skill_code.ts
```

The `SKILL.md` file is used as context for the LLM. Python files with `@AxleExecutor` decorated functions are discoverable as executable skills.

## TODO
- multi-agents

- open website in the workzone

- grep return matched line

- open binary files, word, excel, ppt, pdf...

