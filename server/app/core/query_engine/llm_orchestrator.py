from __future__ import annotations
import asyncio
from typing import AsyncIterator

import google.generativeai as genai

from app.config import get_settings

settings = get_settings()

genai.configure(api_key=settings.gemini_api_key)


async def stream_answer(prompt: str, question: str) -> AsyncIterator[str]:
    """
    Stream tokens from Gemini. generate_content is synchronous so we run it
    in a thread and push chunks through a queue to the async consumer.
    """
    model = genai.GenerativeModel(settings.gemini_chat_model)
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_event_loop()

    def _run():
        try:
            response = model.generate_content(
                prompt,
                generation_config=genai.types.GenerationConfig(
                    temperature=0.2,
                    max_output_tokens=2048,
                ),
                stream=True,
            )
            for chunk in response:
                text = chunk.text if hasattr(chunk, "text") else ""
                if text:
                    loop.call_soon_threadsafe(queue.put_nowait, text)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)  # sentinel

    asyncio.get_event_loop().run_in_executor(None, _run)

    while True:
        token = await queue.get()
        if token is None:
            break
        yield token
