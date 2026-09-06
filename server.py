import os
import json
import asyncio
import websockets
from dotenv import load_dotenv
from core.agent import AxleAgent


class AxleAgentServer:
    """WebSocket server wrapper around AxleAgent."""

    def __init__(self, host="127.0.0.1", port=8080):
        self.host = host
        self.port = port
        self.agent = self._create_agent()
        self.clients = set()

    def _create_agent(self):
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
        agent = AxleAgent(
            base_url=base_url,
            api_key=api_key,
            model_name=model_name,
            skills_folder=skills_folder,
            responses=is_responses,
            base_dir=base_dir
        )
        return agent

    def handle_talk(self, text):
        try:
            result = self.agent.talk(text)
            return result
        except Exception as e:
            return {"error": str(e)}

    def handle_skills(self):
        try:
            result = self.agent.get_skills()
            return result
        except Exception as e:
            return {"error": str(e)}

    def handle_cd(self, path):
        if not os.path.isabs(path):
            path = os.path.join(os.getcwd(), path)
        if not os.path.isdir(path):
            return "not a valid directory"
        self.agent.cd(path)
        return f"Working directory set to {path}"

    def handle_reload(self):
        try:
            self.agent.reload()
            return "Agent reloaded"
        except Exception as e:
            return {"error": str(e)}

    def handle_clear(self):
        try:
            self.agent.clear()
            return "Conversation cleared"
        except Exception as e:
            return {"error": str(e)}

    async def handle_client(self, websocket, path=None):
        self.clients.add(websocket)
        try:
            async for message in websocket:
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    payload = {}
                msg_type = payload.get("type", "")
                result = None
                if msg_type == "talk":
                    text = payload.get("text", "")
                    result = self.handle_talk(text)
                elif msg_type == "skills":
                    result = self.handle_skills()
                elif msg_type == "reload":
                    result = self.handle_reload()
                elif msg_type == "clear":
                    result = self.handle_clear()
                elif msg_type == "cd":
                    path_val = payload.get("path", "")
                    result = self.handle_cd(path_val)
                else:
                    result = {"error": "Unknown message type"}
                await websocket.send(json.dumps(result))
        finally:
            self.clients.discard(websocket)

    async def start_async(self):
        async with websockets.serve(self.handle_client, self.host, self.port):
            print(f"WebSocket server running on ws://{self.host}:{self.port}")
            await asyncio.Future()  # run forever

    def run(self):
        asyncio.run(self.start_async())


if __name__ == "__main__":
    server = AxleAgentServer()
    server.run()
