

import os

from model import Model
from executor import ExecutionResponse, discover_axle_executors, execute
from logger import AxleLogger


class AxleAgent:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model_name: str,
        skills_folder: str,
        responses: bool
    ):
        self.api_key = api_key
        self.model_name = model_name
        self.skills_folder = skills_folder
        self.logger = AxleLogger()
        self.model = Model(
            api_key=api_key,
            base_url=base_url,
            model_name=model_name,
            skills_folder=skills_folder,
            responses = responses,
            logger=self.logger
        )
        
        self.logger.log(f"starting {model_name}")


        # Display loaded skills
        print("\n" + "="*60)
        print(self.model.get_skills_summary())
        print("="*60 + "\n")
        
        # Interactive chat loop
        print("AI Agent ready! Type 'quit' to exit, 'skills' to see skills list.")
        print("Type 'exec <skill_name> <args>' to execute a skill directly.\n")

        self.executors = discover_axle_executors()
        
        self.conversation_history = []
        self.base_dir = os.getcwd()

    def cd(self, dir: str):
        self.base_dir = dir
        print(f"[axle] default working directory: {self.base_dir}")

    def reload(self):
        self.model.reload_skills()
        self.conversation_history = []
        print("\nSkills reloaded and conversation reset.\n")

    def clear(self):
        self.conversation_history = []
        self.model.clear()
        print("\nConversation history cleared.\n")

    def get_skills(self):
        return self.model.get_skills_summary()


    def talk(self, user_input: str):
        
        followup = True
        self.logger.log(f"User: {user_input}")
        while(followup):
            # Get response from agent
            response = self.model.chat(
                user_message=user_input,
                conversation_history=self.conversation_history
            )
            
            print(f"\n[axle] Response: \n{response}\n")
            self.logger.log(f"Response: \n{response}")
            result = execute(response, self.executors, self.base_dir)
            if isinstance(result, ExecutionResponse):
                self.logger.log(f"continue: {result.sequential}")
                needPrint = result.print
                if needPrint and needPrint == True:
                    print(f"[axle] {result.content}")
                
                followup = result.sequential
                if followup:
                    nextPrompt = result.prompt
                    user_input = nextPrompt + "\n" + result.content
                    self.logger.log(f"Auto prompt: {user_input}")
                    print("==" * 30)
                    print(f"[axle] Auto prompt: {nextPrompt}")
                    print("==" * 30)
                else:
                    self.logger.log(f"Result:\n{result.content}")
            else:
                if result:
                    self.logger.log(f"Execution result: {result}")
                else:
                    self.logger.log("Empty result")
                followup = False
            # Update conversation history
            self.conversation_history.append({"role": "user", "content": user_input})
            self.conversation_history.append({"role": "assistant", "content": response})

        user_input = ""
        followup = True
