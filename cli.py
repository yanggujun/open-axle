import os
from dotenv import load_dotenv
from core.agent import AxleAgent


def main():
    """Run the AI agent with configuration from environment variables."""
    # Load environment variables from .env file
    load_dotenv()

    
    skills_folder = os.getenv("SKILLS_FOLDER") or "skills"

    api_key = os.getenv("API_KEY")
    base_url = os.getenv("BASE_URL")
    model_name = os.getenv("MODEL_NAME")
    responses_api = os.getenv("RESPONSES_API")
    is_responses = False
    if responses_api and responses_api.lower() == "true":
        is_responses = True
    
    if not api_key:
        raise ValueError("API_KEY not found in environment variables")
    if not model_name:
        raise ValueError("MODEL_NAME not found in environment variables")
    if not base_url:
        raise ValueError("BASE_URL not found in environment variables")

    base_dir = os.getcwd()
    agent = AxleAgent(base_url = base_url, 
                           api_key = api_key, 
                           model_name = model_name, 
                           skills_folder = skills_folder, 
                           responses = is_responses,
                           base_dir = base_dir)
    

    # Display loaded skills
    print("\n" + "="*60)
    print(agent.get_skills())
    print("="*60 + "\n")
    
    # Interactive chat loop
    print("AI Agent ready! Type 'quit' to exit, 'skills' to see skills list.")
    print("Type 'exec <skill_name> <args>' to execute a skill directly.\n")

    
    while True:
        user_input = input("You: ").strip()
        
        if user_input:
            if user_input.lower() in ['quit', 'exit', 'q']:
                print("Goodbye!")
                break
            elif user_input.lower() == 'skills':
                print("\n" + agent.get_skills())
                print()
            elif user_input.lower().startswith('set '):
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
                            agent.cd(cmd_value)
            elif user_input.lower() == 'reload':
                agent.reload()
            elif user_input.lower() == 'clear':
                agent.clear()
            else:
                agent.talk(user_input)
        
if __name__ == "__main__":
    main()
