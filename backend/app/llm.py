"""LangChain-based LLM adapter used by the RAG and workflow services.

LangChain is intentionally limited to prompt composition, model invocation,
and validated structured output. Retrieval, workflow state, approvals, and
fallbacks remain explicit application logic.
"""
from typing import Literal, TypeVar

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from .retry import with_retries


class RouteDecision(BaseModel):
    route: Literal["knowledge", "draft", "workflow", "clarify"]
    confidence: float = Field(ge=0.0, le=1.0)
    needs_retrieval: bool = True
    label: str
    clarification: str | None = None


class InquiryClassification(BaseModel):
    intent: Literal["email", "proposal", "service"]
    product: str | None = None
    temperature: str | None = None
    pressure: str | None = None
    flow: str | None = None
    customer: str | None = None
    missing: list[str] = Field(default_factory=list)


SchemaT = TypeVar("SchemaT", bound=BaseModel)


def _history_messages(history: list[dict[str, str]] | None) -> list[BaseMessage]:
    messages: list[BaseMessage] = []
    for turn in history or []:
        content = str(turn.get("content", "")).strip()
        if not content:
            continue
        if turn.get("role") == "assistant":
            messages.append(AIMessage(content=content))
        else:
            messages.append(HumanMessage(content=content))
    return messages


def _prompt(system_prompt: str) -> ChatPromptTemplate:
    # A SystemMessage is used instead of a string template because several
    # prompts contain JSON examples whose braces should remain literal.
    return ChatPromptTemplate.from_messages(
        [
            SystemMessage(content=system_prompt),
            MessagesPlaceholder(variable_name="history", optional=True),
            ("human", "{user_content}"),
        ]
    )


class LangChainLLM:
    """Small, typed boundary around LangChain's OpenAI integration."""

    def __init__(self, *, api_key: str, model: str):
        # Disable SDK-level retries because retry.py owns the retry policy and
        # records consistent labels across chat and embedding calls.
        self._model = ChatOpenAI(
            api_key=api_key,
            model=model,
            max_retries=0,
        )

    def _invoke(
        self,
        *,
        chain,
        user_content: str,
        history: list[dict[str, str]] | None,
        label: str,
    ):
        return with_retries(
            lambda: chain.invoke(
                {
                    "history": _history_messages(history),
                    "user_content": user_content,
                }
            ),
            label=label,
        )

    def text(
        self,
        *,
        system_prompt: str,
        user_content: str,
        temperature: float = 0.3,
        history: list[dict[str, str]] | None = None,
        label: str = "langchain.text",
    ) -> str:
        message = self._invoke(
            chain=_prompt(system_prompt) | self._model.bind(temperature=temperature),
            user_content=user_content,
            history=history,
            label=label,
        )
        content = getattr(message, "content", message)
        return content.strip() if isinstance(content, str) else str(content).strip()

    def structured(
        self,
        *,
        schema: type[SchemaT],
        system_prompt: str,
        user_content: str,
        temperature: float = 0.0,
        history: list[dict[str, str]] | None = None,
        label: str = "langchain.structured",
    ) -> SchemaT:
        # Bind temperature on the chat model first. Binding after
        # with_structured_output can send kwargs to the output parser.
        structured_model = self._model.bind(temperature=temperature).with_structured_output(schema)
        response = self._invoke(
            chain=_prompt(system_prompt) | structured_model,
            user_content=user_content,
            history=history,
            label=label,
        )
        if isinstance(response, schema):
            return response
        return schema.model_validate(response)
