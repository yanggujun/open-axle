# Open Axle

Open Axle is a simple but effective CLI AI agent.

## Requirements

- Python 3.13 or newer
- An API key for an OpenAI-compatible endpoint

## Installation

```bash
pip install -r requirements.txt
```

Or install as a package:

```bash
pip install .
```

## Configuration

Copy `.env.sample` to `.env` and set the required environment variables:

- `API_KEY` — your API key (required)
- `BASE_URL` — API base URL (e.g., `https://api.openai.com/v1/chat/completions`)
- `MODEL_NAME` — model identifier to use
- `SKILLS_FOLDER` — path to the skills folder (default: `skills`)
- `RESPONSES_API` — set to `TRUE` to use the Responses API

Copy `.axle.sample` to `.axle` to configure skill-specific settings (database connections, API auth, etc.).

## Usage

Run the CLI:

```bash
open-axle
```

Or run directly:

```bash
python axle.py
```

Inside the interactive loop:

- Type your message to chat with the agent
- `skills` — list all loaded skills
- `set pwd <path>` — set the default working directory
- `reload` — reload skills and reset conversation
- `clear` — clear conversation history
- `quit`, `exit`, or `q` — exit the agent

## Skills Folder Structure

Each skill is a subdirectory of `skills/` containing a `SKILL.md` file:

```
skills/
  my-skill/
    SKILL.md
    skill_code.py
```

The `SKILL.md` file is used as context for the LLM. Python files with `@AxleExecutor` decorated functions are discoverable as executable skills.
