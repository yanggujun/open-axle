"""
AI Agent module with skills support.
Provides SkillsAIAgent that loads SKILL.md files from a skills folder
and uses them as context for LLM conversations.
"""

import os
import glob
import platform
from typing import List, Dict, Optional, Any
from axle_logger import AxleLogger
from openai import OpenAI

import requests


class SkillsAIAgent:
    """
    An AI agent that loads skill definitions from markdown files
    and uses them as system context for LLM-powered conversations.
    """

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.openai.com/v1",
        model_name: str = "gpt-3.5-turbo",
        skills_folder: str = "skills",
        temperature: float = 0.7,
        max_tokens: int = 131072,
        responses: bool = False,
        logger: AxleLogger = None
    ):
        """
        Initialize the SkillsAIAgent.

        Args:
            api_key: API key for the LLM provider.
            base_url: Base URL for the OpenAI-compatible API endpoint.
            model_name: Model identifier to use for completions.
            skills_folder: Path to the folder containing skill sub-directories with SKILL.md files.
            temperature: Sampling temperature for generation.
            max_tokens: Maximum tokens for the response.
        """
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.skills_folder = skills_folder
        self.max_tokens = max_tokens
        self.responses = responses
        self.previous_resp_id = None
        self.logger = logger

        # Load skills from the folder
        self.skills_content: Dict[str, str] = {}
        self._load_skills()

        # Build the system prompt
        self.system_prompt = self._build_system_prompt()
        if responses:
            print("Using Responses API")
            logger.log("Using Responses API")
            self.reponses_client = OpenAI(
                base_url=self.base_url,
                api_key=self.api_key
            )

    def _load_skills(self):
        """Load all SKILL.md files from the skills folder."""
        self.skills_content = {}

        if not os.path.isdir(self.skills_folder):
            print(f"⚠️  Skills folder '{self.skills_folder}' not found.")
            return

        # Walk through each subdirectory in the skills folder
        for entry in sorted(os.listdir(self.skills_folder)):
            skill_dir = os.path.join(self.skills_folder, entry)
            if not os.path.isdir(skill_dir):
                continue

            # Skip __pycache__ and hidden directories
            if entry.startswith("__") or entry.startswith("."):
                continue

            skill_md_path = os.path.join(skill_dir, "SKILL.md")
            if os.path.isfile(skill_md_path):
                try:
                    with open(skill_md_path, "r", encoding="utf-8") as f:
                        content = f.read()
                    self.skills_content[entry] = content
                except Exception as e:
                    print(f"⚠️  Error loading skill '{entry}': {e}")

        print(f"📚 Loaded {len(self.skills_content)} skill(s) from '{self.skills_folder}/'")

    def _build_system_prompt(self) -> str:
        """Build the system prompt incorporating all loaded skills."""
        parts = []

        # Base system prompt
        parts.append(
            "You are an intelligent AI assistant equipped with specialized skills. "
            "You should use these skills when appropriate to help the user effectively.\n"
            "\n"
            "## Your Capabilities\n"
            "\n"
            "Below are the skills available to you. Each skill has a description and "
            "guidelines for when and how to use it.\n"
        )

        osVersion = platform.platform()
        print(f"OS: {osVersion}")
        parts.append(f"The current operating system is {osVersion}. You should provide operating system specific commands and analysis for operating system related tasks.\n")
        

        # Add each skill's content
        if self.skills_content:
            for skill_name, content in self.skills_content.items():
                parts.append(f"\n---\n### Skill: `{skill_name}`\n\n{content}\n")
        else:
            parts.append(
                "\n(No skills are currently loaded. Respond using your general knowledge.)\n"
            )

        # Add general guidelines
        parts.append(
            "\n---\n"
            "## General Guidelines\n"
            "\n"
            "- Use skills when the user's request matches a skill's trigger conditions.\n"
            "- If no skill is relevant, respond using your general knowledge.\n"
            "- Be concise, accurate, and helpful.\n"
            "- When executing skill-related tasks, follow the skill's documented patterns.\n"
        )

        # Append SYSTEM.md content from the skills folder, if present
        system_md_path = os.path.join(self.skills_folder, "SYSTEM.md")
        if os.path.isfile(system_md_path):
            try:
                with open(system_md_path, "r", encoding="utf-8") as f:
                    system_md_content = f.read()
                parts.append(f"\n---\n{system_md_content}\n")
                print(f"📄 Loaded system instructions from '{system_md_path}'")
            except Exception as e:
                print(f"⚠️  Error loading SYSTEM.md: {e}")

        return "".join(parts)

    def reload_skills(self):
        """Reload all skills from the skills folder and rebuild the system prompt."""
        print("\n🔄 Reloading skills...")
        self._load_skills()
        self.system_prompt = self._build_system_prompt()
        print("✅ Skills reloaded successfully.")

    def get_skills_summary(self) -> str:
        """
        Get a summary of all loaded skills.

        Returns:
            A formatted string listing all loaded skills.
        """
        if not self.skills_content:
            return "No skills loaded."

        lines = ["Loaded Skills:"]
        lines.append("-" * 40)
        for i, skill_name in enumerate(self.skills_content.keys(), 1):
            lines.append(f"  {i}. {skill_name}")
        lines.append("-" * 40)
        lines.append(f"Total: {len(self.skills_content)} skill(s)")
        return "\n".join(lines)

    def chat(
        self,
        user_message: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
    ) -> str:
        """
        Send a message to the LLM and get a response.

        Args:
            user_message: The user's input message.
            conversation_history: Previous conversation messages (list of dicts with 'role' and 'content').

        Returns:
            The assistant's response text.
        """
        # Build messages list
        messages = [{"role": "system", "content": self.system_prompt}]

        # Add conversation history if provided
        if conversation_history:
            for msg in conversation_history:
                messages.append({
                    "role": msg["role"],
                    "content": msg["content"],
                })

        # Add the current user message
        messages.append({"role": "user", "content": user_message})

        # Make the API call
        try:
            if self.responses:
                response = self._call_llm_responses_api(user_message)
            else:    
                response = self._call_llm(messages)
            return response
        except Exception as e:
            return f"Error communicating with LLM: {str(e)}"

    def _call_llm(self, messages: List[Dict[str, str]]) -> str:
        url = self.base_url

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        payload = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": self.max_tokens,
        }

        response = requests.post(url, headers=headers, json=payload, timeout=120)

        if response.status_code != 200:
            error_detail = response.text
            error = f"API request failed with status {response.status_code}: {error_detail}"
            self.logger.log(error)
            raise Exception(error)

        data = response.json()

        # Extract the assistant's message
        if "choices" in data and len(data["choices"]) > 0:
            choice = data["choices"][0]
            if "message" in choice and "content" in choice["message"]:
                return choice["message"]["content"]

        raise Exception(f"Unexpected API response format: {data}")

    def _call_llm_responses_api(self, messages: str) -> str:
        tools = [
            {
                "type": "call",
                "action": "action_name, please generate the action STRICTLY following the name inthe skills",
                "thinking": "the think trace of LLM",
                "sequential": {
                    "prompt": "prompt used as input for all of following tasks, NOT JUST next task, so that all of the following tasks are not missed."
                },
                "properties": [
                    { "name": "property1", "value": "value1" },
                    { "name": "property2", "value": "value2" }
                ]
            }
        ]

        kwargs = {
            "model": self.model_name,
            "instructions": self.system_prompt,
            "input": messages,
            "tools": tools
        }
        if self.previous_resp_id:
            self.logger.log(f"previous response id: {self.previous_resp_id}")
            kwargs["previous_response_id"] = self.previous_resp_id
        else:
            self.logger.log("previous response id is empty")


        response = self.reponses_client.responses.create(**kwargs)
        self.previous_resp_id = response.id

        # if response.status_code != 200:
        #     error_detail = response.text
        #     raise Exception(
        #         f"API request failed with status {response.status_code}: {error_detail}"
        #     )
        return response.output_text


    def clear(self):
        self.previous_resp_id = None