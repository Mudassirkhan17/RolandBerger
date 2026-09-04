"""Small retry helper for transient OpenAI API failures.

Wraps a zero-arg callable and retries it a few times with exponential
backoff when the failure looks transient (rate limits, timeouts,
connection errors, 5xx). Anything else (auth errors, bad requests) is
raised immediately so callers' existing offline/heuristic fallbacks
still kick in without unnecessary delay.
"""
import logging
import time
from typing import Callable, TypeVar

from openai import APIConnectionError, APIStatusError, APITimeoutError, RateLimitError

logger = logging.getLogger("helios.retry")

T = TypeVar("T")

_RETRYABLE = (RateLimitError, APIConnectionError, APITimeoutError)


def with_retries(
    fn: Callable[[], T],
    *,
    attempts: int = 3,
    base_delay: float = 0.6,
    label: str = "openai_call",
) -> T:
    """Call fn(), retrying on transient OpenAI errors with exponential backoff.

    Raises the last exception if every attempt fails, so the caller's
    existing except-block fallback logic still applies unchanged.
    """
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except _RETRYABLE as exc:
            last_exc = exc
            if attempt == attempts:
                break
            delay = base_delay * (2 ** (attempt - 1))
            logger.warning(
                "%s: transient error on attempt %d/%d (%s) — retrying in %.1fs",
                label, attempt, attempts, type(exc).__name__, delay,
            )
            time.sleep(delay)
        except APIStatusError as exc:
            # Retry server-side errors (5xx) but not client errors (4xx).
            last_exc = exc
            if exc.status_code < 500 or attempt == attempts:
                raise
            delay = base_delay * (2 ** (attempt - 1))
            logger.warning(
                "%s: server error %s on attempt %d/%d — retrying in %.1fs",
                label, exc.status_code, attempt, attempts, delay,
            )
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc
