import os
from dotenv import load_dotenv
from axle_agent import AxleAgent


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

    axle_agent = AxleAgent(base_url = base_url, 
                           api_key = api_key, 
                           model_name = model_name, 
                           skills_folder = skills_folder, 
                           responses = is_responses)
    

    
    while True:
        user_input = input("You: ").strip()
        
        if user_input.lower() in ['quit', 'exit', 'q']:
            print("Goodbye!")
            break
        axle_agent.talk(user_input)
        
if __name__ == "__main__":
    main()