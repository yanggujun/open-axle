

import os

from core.conduit import Conduit
from core.model import Model
from core.executor import ExecutionResponse, discover_axle_executors, execute
from core.logger import AxleLogger


class AxleAgent:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model_name: str,
        skills_folder: str,
        responses: bool,
        base_dir: str,
        conduit: Conduit
    ):
        self.api_key = api_key
        self.model_name = model_name
        self.skills_folder = skills_folder
        self.logger = AxleLogger(base_dir)
        self.model = Model(
            api_key=api_key,
            base_url=base_url,
            model_name=model_name,
            skills_folder=skills_folder,
            responses = responses,
            logger=self.logger
        )
        
        self.logger.log(f"starting {model_name}")
        self.executors = discover_axle_executors()
        self.conversation_history = []
        self.base_dir = base_dir
        self.conduit = conduit

    def cd(self, dir: str):
        self.base_dir = dir
        self.conduit.send(f"Working directory changed to: {self.base_dir}")

    def reload(self):
        self.model.reload_skills()
        self.conversation_history = []
        self.conduit.send("\nSkills reloaded and conversation reset.\n")

    def clear(self):
        self.conversation_history = []
        self.model.clear()
        self.conduit.send("\nConversation history cleared.\n")

    def get_skills(self):
        skills = self.model.get_skills_summary()
        self.conduit.send(skills)
        return skills


    def talk(self, user_input: str):
        
        followup = True
        self.logger.log(f"User: {user_input}")
        while(followup):
            # Get response from agent
            response = self.model.chat(
                user_message=user_input,
                conversation_history=self.conversation_history
            )

            self.logger.log(f"Response: \n{response}")
            result = execute(response, self.executors, self.base_dir)
            if isinstance(result, ExecutionResponse):
                self.logger.log(f"continue: {result.sequential}")
                needPrint = result.print
                if needPrint and needPrint == True:
                    self.conduit.send(f"{result.content}")
                
                followup = result.sequential
                if followup:
                    nextPrompt = result.prompt
                    user_input = nextPrompt + "\n" + result.content
                    self.logger.log(f"Auto prompt: {user_input}")
                    self.conduit.send(nextPrompt)
                else:
                    self.logger.log(f"Result:\n{result.content}")
            else:
                if result:
                    self.logger.log(f"Execution result: {result}")
                    self.conduit.send(result)
                else:
                    self.logger.log("Empty result")
                    self.conduit.send("No response")
                followup = False
            # Update conversation history
            self.conversation_history.append({"role": "user", "content": user_input})
            self.conversation_history.append({"role": "assistant", "content": response})

        user_input = ""
        followup = True
