import os
import json
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from dotenv import load_dotenv
from core.agent import AxleAgent


class AxleAgentServer:
    """HTTP server wrapper around AxleAgent, mimicking the CLI interface of axle.py."""

    def __init__(self, host="127.0.0.1", port=8080):
        self.host = host
        self.port = port
        self.agent = self._create_agent()
        self.http_server = None

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

        agent = AxleAgent(
            base_url=base_url,
            api_key=api_key,
            model_name=model_name,
            skills_folder=skills_folder,
            responses=is_responses
        )
        return agent

    def handle_talk(self, text):
        """Calls agent.talk() and returns its output."""
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
        # Same logic as axle.py: resolve absolute path and validate directory
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

    def _make_handler(self):
        server_ref = self

        class Handler(BaseHTTPRequestHandler):
            def _send_json(self, status, data):
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode("utf-8"))

            def do_GET(self):
                if self.path.startswith("/skills"):
                    result = server_ref.handle_skills()
                    self._send_json(200, result)
                elif self.path.startswith("/reload"):
                    result = server_ref.handle_reload()
                    self._send_json(200, result)
                elif self.path.startswith("/clear"):
                    result = server_ref.handle_clear()
                    self._send_json(200, result)
                else:
                    self._send_json(404, {"error": "Not found"})

            def do_POST(self):
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length) if content_length > 0 else b""
                try:
                    payload = json.loads(body) if body else {}
                except json.JSONDecodeError:
                    payload = {}

                if self.path.startswith("/talk"):
                    text = payload.get("text", "")
                    result = server_ref.handle_talk(text)
                    self._send_json(200, result)
                elif self.path.startswith("/cd"):
                    path = payload.get("path", "")
                    result = server_ref.handle_cd(path)
                    self._send_json(200, result)
                else:
                    self._send_json(404, {"error": "Not found"})

        return Handler

    def start(self):
        handler = self._make_handler()
        self.http_server = HTTPServer((self.host, self.port), handler)
        print(f"HTTP server running on {self.host}:{self.port}")
        try:
            self.http_server.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down...")
            self.http_server.shutdown()

    def start_in_thread(self):
        """Starts the server in a background thread and returns it."""
        server_ref = self
        thread = threading.Thread(target=server_ref.start, daemon=True)
        thread.start()
        return thread


if __name__ == "__main__":
    server = AxleAgentServer()
    server.start()
