import os
import json
import asyncio
import websockets
from dotenv import load_dotenv
from core.agent import AxleAgent
from core.conduit import QueuedConduit


class AxleAgentServer:
    """WebSocket server wrapper around AxleAgent."""

    def __init__(self, host="127.0.0.1", port=8080):
        self.host = host
        self.port = port
        self.clients = set()

        self.conduit = QueuedConduit()
        self.conduit.subscribe(self._broadcast_message)
        # NOTE: Do NOT start the conduit here. It must be started inside the
        # running event loop (see start_async) so that broadcast messages and
        # websocket sends share the same event loop.
        self.agent = self._create_agent()

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
            base_dir=base_dir,
            conduit=self.conduit
        )
        return agent

    async def _broadcast_message(self, message):
        """
        Callback registered with QueueMessageHandler.
        Sends the queued message to all connected websocket clients.
        """
        payload = json.dumps({"type": "broadcast", "message": message})
        if not self.clients:
            return
        # Send to all connected clients; ignore disconnected ones.
        disconnected = []
        for websocket in self.clients:
            try:
                await websocket.send(payload)
            except Exception:
                disconnected.append(websocket)
        for websocket in disconnected:
            self.clients.discard(websocket)

    def handle_talk(self, text):
        try:
            return self.agent.talk(text)
        except Exception as e:
            return {"error": str(e)}

    def handle_skills(self):
        try:
            return self.agent.get_skills()
        except Exception as e:
            return {"error": str(e)}

    def handle_cd(self, path):
        if not os.path.isabs(path):
            path = os.path.join(os.getcwd(), path)
        if not os.path.isdir(path):
            return "not a valid directory"
        self.agent.cd(path)
        return "changed directory"

    def handle_reload(self):
        try:
            self.agent.reload()
            return "reloaded"
        except Exception as e:
            return {"error": str(e)}

    def handle_clear(self):
        try:
            self.agent.clear()
            return "cleared"
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
                # Send the result directly to the requesting client. Relying on
                # the conduit broadcast would duplicate the response because the
                # broadcast delivers to every connected client.
                if result is not None:
                    response_payload = json.dumps({"type": msg_type, "result": result})
                    await websocket.send(response_payload)
        finally:
            self.clients.discard(websocket)

    async def start_async(self):
        # Start the conduit here, inside the running event loop, so that the
        # broadcast callback uses the same loop as the WebSocket server.
        self.conduit.start()
        async with websockets.serve(self.handle_client, self.host, self.port):
            print(f"WebSocket server running on ws://{self.host}:{self.port}")
            await asyncio.Future()  # run forever

    def run(self):
        asyncio.run(self.start_async())


if __name__ == "__main__":
    server = AxleAgentServer()
    server.run()
