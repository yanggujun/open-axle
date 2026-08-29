

import os

from ai_agent import SkillsAIAgent
from axle_executor import ExecutionResponse, discover_axle_executors, execute
from axle_logger import AxleLogger
from skills import SkillManager


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
            # Initialize the agent
        print("Initializing AI Agent...\n")
        self.agent = SkillsAIAgent(
            api_key=api_key,
            base_url=base_url,
            model_name=model_name,
            skills_folder=skills_folder,
            responses = responses,
            logger=self.logger
        )
        
        
        # Create a skill manager for executable skills
        self.skill_manager = SkillManager()

        self.logger.log(f"starting {model_name}")


        # Display loaded skills
        print("\n" + "="*60)
        print(self.agent.get_skills_summary())
        print(f"\nExecutable skills registered: {len(self.skill_manager.skills)}")
        for name in self.skill_manager.skills:
            print(f"  - {name}")
        print("="*60 + "\n")
        
        # Interactive chat loop
        print("AI Agent ready! Type 'quit' to exit, 'skills' to see skills list.")
        print("Type 'exec <skill_name> <args>' to execute a skill directly.\n")

        self.executors = discover_axle_executors()
        
        self.conversation_history = []
        self.base_dir = os.getcwd()

    def talk(self, user_input: str):
        
        if user_input.lower() == 'skills':
            print("\n" + self.agent.get_skills_summary())
            print(f"\nExecutable skills: {len(self.skill_manager.skills)}")
            for name, skill in self.skill_manager.skills.items():
                print(f"  - {name}: {skill.description[:60]}...")
            print()
            return
        
        if user_input.lower().startswith('exec '):
            # Direct skill execution: exec <skill_name> <args>
            parts = user_input[5:].strip().split(maxsplit=1)
            if parts:
                skill_name = parts[0]
                skill_args = parts[1] if len(parts) > 1 else ""
                try:
                    result = self.skill_manager.execute_skill(skill_name, skill_args)
                    print(f"\n[Skill Result] {result}\n")
                except Exception as e:
                    print(f"\n[Skill Error] {e}\n")
            else:
                print("\nUsage: exec <skill_name> <args>\n")
            return

        if user_input.lower().startswith('set '):
            splits = user_input[4:].strip().split(maxsplit=1)
            if splits:
                rsv_cmd = splits[0]
                cmd_value = splits[1] if len(splits) > 1 else ""
                if rsv_cmd.lower() == 'pwd':
                    if not os.path.isabs(cmd_value):
                        cmd_value = os.path.join(os.getcwd(), cmd_value)
                    if not os.path.isdir(cmd_value):
                        print("not a valid directory")
                    else:
                        self.base_dir = cmd_value
            print(f"[axle] default working directory: {self.base_dir}")
            self.logger.log(f"default working directory: {self.base_dir}")
            return
        
        if user_input.lower() == 'reload':
            self.agent.reload_skills()
            self.conversation_history = []
            print("\nSkills reloaded and conversation reset.\n")
            return
        
        if user_input.lower() == 'clear':
            self.conversation_history = []
            self.agent.clear()
            print("\nConversation history cleared.\n")
            return
        
        if not user_input:
            return
        
        followup = True
        self.logger.log(f"user: {user_input}")
        while(followup):
            # Get response from agent
            response = self.agent.chat(
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
                    self.logger.log(f"prompt: {user_input}")
                    print("==" * 30)
                    print(f"[axle] prompt: {nextPrompt}")
                    print("==" * 30)
                else:
                    self.logger.log(f"result:\n{result.content}")
            else:
                if result:
                    self.logger.log(f"execution result: {result}")
                else:
                    self.logger.log("empty result")
                followup = False
            # Update conversation history
            self.conversation_history.append({"role": "user", "content": user_input})
            self.conversation_history.append({"role": "assistant", "content": response})

        user_input = ""
        followup = True
