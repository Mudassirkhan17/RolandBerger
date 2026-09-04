"""Run the supplied retrieval and grounded-answer evaluation set."""

import json
import re
from pathlib import Path

from backend.app.main import CORPUS_PATH, rag


def token_f1(expected: str, actual: str) -> float:
    expected_tokens = set(re.findall(r"[a-z0-9-]+", expected.lower()))
    actual_tokens = set(re.findall(r"[a-z0-9-]+", actual.lower()))
    if not expected_tokens or not actual_tokens:
        return 0.0
    overlap = len(expected_tokens & actual_tokens)
    precision = overlap / len(actual_tokens)
    recall = overlap / len(expected_tokens)
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def main() -> None:
    questions = json.loads(
        (CORPUS_PATH / "metadata" / "eval_questions.json").read_text(encoding="utf-8")
    )
    total_required = 0
    total_retrieved = 0
    answer_scores: list[float] = []

    print("Helios RAG evaluation")
    print("=" * 72)
    for item in questions:
        result = rag.answer(item["question"], log=False)
        actual_sources = {Path(citation.file).name for citation in result.citations}
        required_sources = set(item["required_sources"])
        retrieved = len(actual_sources & required_sources)
        total_required += len(required_sources)
        total_retrieved += retrieved
        score = token_f1(item["expected_answer"], result.answer)
        answer_scores.append(score)
        print(
            f"{item['id']}: grounded={str(result.grounded):5} "
            f"source_coverage={retrieved}/{len(required_sources)} "
            f"answer_token_f1={score:.2f}"
        )

    print("-" * 72)
    print(f"Grounded responses: {len(answer_scores)}/{len(questions)}")
    print(f"Required-source recall@5: {total_retrieved / total_required:.1%}")
    print(f"Mean answer token F1: {sum(answer_scores) / len(answer_scores):.2f}")


if __name__ == "__main__":
    main()
