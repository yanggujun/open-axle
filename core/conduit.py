import asyncio
from abc import ABC, abstractmethod
from collections import deque
from typing import Any, Callable, Awaitable


class Conduit(ABC):
    """Interface for message conduits."""

    @abstractmethod
    def send(self, message: Any) -> None:
        """Synchronously send a message."""
        pass

    @abstractmethod
    async def send_async(self, message: Any) -> None:
        """Asynchronously send a message."""
        pass


class QueuedConduit(Conduit):
    """
    Handles queued messages from callers and broadcasts them via registered callbacks.

    Callers enqueue messages; the handler processes them and delivers each to
    registered subscribers (e.g., the server broadcasts via websockets).
    """

    def __init__(self):
        self._queue = deque()
        self._event = asyncio.Event()
        self._subscribers = []
        self._running = False
        self._task = None
        self._thread = None

    # --- Conduit interface ---

    def send(self, message: Any) -> None:
        """Synchronously send (enqueue) a message from a caller."""
        self.enqueue(message)

    async def send_async(self, message: Any) -> None:
        """Asynchronously send (enqueue) a message from a caller."""
        await self.enqueue_async(message)

    # --- Public API for callers ---

    def enqueue(self, message: Any) -> None:
        """Synchronously enqueue a message from a caller."""
        self._queue.append(message)
        self._event.set()

    async def enqueue_async(self, message: Any) -> None:
        """Asynchronously enqueue a message from a caller."""
        self._queue.append(message)
        self._event.set()

    def subscribe(self, callback: Callable[[Any], Awaitable[None]]) -> None:
        """
        Register an async callback to receive messages as they are processed.
        The callback should be an async function that accepts the message.
        """
        self._subscribers.append(callback)

    # --- Lifecycle ---

    def start(self) -> None:
        """Start processing queued messages."""
        if self._running:
            return
        self._running = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop in this thread; run our own in a background thread.
            import threading
            self._thread = threading.Thread(target=self._run_in_thread, daemon=True)
            self._thread.start()
        else:
            self._task = loop.create_task(self._process_loop())

    def stop(self) -> None:
        """Stop processing queued messages."""
        self._running = False
        self._event.set()

    # --- Internal ---

    def _run_in_thread(self) -> None:
        """Run the async processing loop in a dedicated thread."""
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(self._process_loop())

    async def _process_loop(self) -> None:
        """Process queued messages and notify subscribers."""
        while self._running:
            if not self._queue:
                # No messages yet - wait for the event to be set by enqueue().
                self._event.clear()
                await self._event.wait()
                continue

            # Dequeue the next message and deliver it to all subscribers.
            message = self._queue.popleft()
            for callback in self._subscribers:
                try:
                    await callback(message)
                except Exception as e:
                    print(f"QueueMessageHandler: subscriber error: {e}")


class ConsoleConduit(Conduit):
    """Conduit implementation that prints messages to the console."""

    def send(self, message: Any) -> None:
        """Synchronously print the message."""
        print(message)

    async def send_async(self, message: Any) -> None:
        """Asynchronously print the message."""
        print(message)
