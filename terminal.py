#!/usr/bin/env python3
"""A basic Linux terminal emulator GUI built with Tkinter.

Features:
- Execute shell commands via subprocess in a persistent working directory
- Command history navigation (Up / Down arrows)
- CTRL+C / CTRL+L key bindings
- Scrollable output area
"""

import os
import subprocess
import sys
import tkinter as tk
from tkinter import scrolledtext

from agent import AxleAgent


class TerminalGUI:
    def __init__(self, root: tk.Tk, agent: AxleAgent):
        self.root = root
        self.root.title("Python Terminal")
        self.root.geometry("900x600")

        self.cwd = os.getcwd()
        self.history: list[str] = []
        self.history_index: int = 0
        self.current_input: str = ""
        self.agent = agent

        self._build_interface()

        self.print_banner()
        self.prompt()

    def _build_interface(self) -> None:
        # Output area (read-only, scrollable)
        self.terminal = scrolledtext.ScrolledText(
            self.root,
            wrap=tk.WORD,
            font=("Courier New", 11),
            bg="#1e1e1e",
            fg="#00ff00",
            insertbackground="#00ff00",
            state="disabled",
        )
        self.terminal.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)

        # Input line
        self.input_frame = tk.Frame(self.root)
        self.input_frame.pack(fill=tk.X, padx=5, pady=5)

        self.prompt_label = tk.Label(
            self.input_frame, text="$", font=("Courier New", 11), bg="#1e1e1e", fg="#00ff00"
        )
        self.prompt_label.pack(side=tk.LEFT)

        self.command_var = tk.StringVar()
        self.command_entry = tk.Entry(
            self.input_frame,
            textvariable=self.command_var,
            font=("Courier New", 11),
            bg="#1e1e1e",
            fg="#00ff00",
            insertbackground="#00ff00",
            relief=tk.SUNKEN,
        )
        self.command_entry.pack(fill=tk.X, side=tk.LEFT, expand=True)
        self.command_entry.bind("<Return>", self.execute_command)
        self.command_entry.bind("<Up>", self.history_up)
        self.command_entry.bind("<Down>", self.history_down)

        # Focus entry and set up key bindings for the whole app
        self.command_entry.focus_set()
        self.root.bind("<Control-c>", self.handle_ctrl_c)
        self.root.bind("<Control-l>", self.handle_ctrl_l)

    def print_banner(self) -> None:
        self.write(
            "Python Terminal Emulator\n"
            "Type 'help' for available built-in commands.\n"
            "Use Up/Down arrows to browse history.\n"
            "CTRL+C to interrupt, CTRL+L to clear.\n\n"
        )

    def prompt(self) -> None:
        self.write(f"{self.cwd}$ ")

    def write(self, text: str) -> None:
        self.terminal.config(state=tk.NORMAL)
        self.terminal.insert(tk.END, text)
        self.terminal.see(tk.END)
        self.terminal.config(state=tk.DISABLED)

    def execute_command(self, _event=None) -> None:
        raw = self.command_var.get().strip()
        self.command_var.set("")
        if not raw:
            self.prompt()
            return

        # Save to history
        self.history.append(raw)
        self.history_index = len(self.history)

        self.write(raw + "\n")

        # Handle internal commands
        if raw == "help":
            self.show_help()
            self.prompt()
            return
        if raw == "clear" or raw == "cls":
            self.clear()
            self.prompt()
            return
        if raw == "exit":
            self.exit_terminal()
            return
        if raw.startswith("cd "):
            self.change_directory(raw[3:].strip())
            self.prompt()
            return
        if raw == "pwd":
            self.write(self.cwd + "\n")
            self.prompt()
            return
        self.talk(raw)

    def talk(self, user_input: str):
        self.agent.talk(user_input)
        self.prompt()

    def run_shell_command(self, command: str) -> None:
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=self.cwd,
                capture_output=True,
                text=True,
                timeout=None,
            )
            if proc.stdout:
                self.write(proc.stdout)
            if proc.stderr:
                self.write(proc.stderr)
            if proc.returncode != 0 and not proc.stdout and not proc.stderr:
                self.write(f"[exit code: {proc.returncode}]\n")
        except Exception as exc:
            self.write(f"Error: {exc}\n")
        self.prompt()

    def change_directory(self, path: str) -> None:
        if not path:
            self.cwd = os.path.expanduser("~")
            return
        if not os.path.isabs(path):
            path = os.path.join(self.cwd, path)
        path = os.path.expanduser(path)
        if os.path.isdir(path):
            self.cwd = os.path.normpath(path)
            self.agent.cd(path)
        else:
            self.write(f"cd: no such file or directory: {path}\n")

    def handle_ctrl_c(self, _event=None) -> None:
        self.write("^C\n")
        self.command_var.set("")
        self.prompt()

    def handle_ctrl_l(self, _event=None) -> None:
        self.clear()
        self.prompt()

    def clear(self) -> None:
        self.terminal.config(state=tk.NORMAL)
        self.terminal.delete("1.0", tk.END)
        self.terminal.config(state=tk.DISABLED)

    def show_help(self) -> None:
        self.write(
            "Built-in commands:\n"
            "  help               Show this help\n"
            "  clear, cls         Clear the terminal\n"
            "  exit               Close the terminal\n"
            "  cd <dir>           Change directory\n"
            "  pwd                Print working directory\n"
            "  (any other command is run in the system shell)\n\n"
        )

    def history_up(self, _event=None) -> None:
        if not self.history:
            return
        if self.history_index > 0:
            self.history_index -= 1
        self.command_var.set(self.history[self.history_index])
        self.command_entry.icursor(tk.END)

    def history_down(self, _event=None) -> None:
        if not self.history:
            return
        if self.history_index < len(self.history) - 1:
            self.history_index += 1
            self.command_var.set(self.history[self.history_index])
        else:
            self.history_index = len(self.history)
            self.command_var.set("")
        self.command_entry.icursor(tk.END)

    def exit_terminal(self) -> None:
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    TerminalGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()
