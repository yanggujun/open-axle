
from datetime import datetime
import os

from dotenv import load_dotenv

class AxleLogger:

    def __init__(self):
        load_dotenv()
        path = os.getenv("LOG_PATH")
        file_name = os.getenv("LOG_FILE_NAME")
        if path and os.path.isabs(path):
            raise ValueError("log path should not be an absolute path")

        full_path = ""
        if not path:
            full_path = os.path.join(os.getcwd(), ".logs");
        else:
            full_path = os.path.join(os.getcwd(), path)

        fname = ""
        if not file_name:
            fname = "axle.log"
        else:
            fname = file_name

        if not os.path.exists(full_path):
            os.makedirs(full_path)

        today = datetime.now().date()
        fname = f"{today.strftime("%Y-%m-%d")}-{fname}"

        file_path = os.path.join(full_path, fname)

        if not os.path.exists(file_path):
            open(file_path, "w").close

        self.log_file_path = file_path

    def log(self, content):
        with open(self.log_file_path, "a", encoding="utf-8") as f:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            f.write(f"[axle] {timestamp}\n")
            f.write(content + "\n")