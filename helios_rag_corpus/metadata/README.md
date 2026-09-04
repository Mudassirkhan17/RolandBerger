# Helios Industrial Systems - Synthetic RAG Knowledge Corpus

This dataset is entirely synthetic and was created for an enterprise Generative AI Sales & Service Copilot prototype.

## Corpus size

- Product documentation: 8
- Technical manuals: 6
- Previous proposals: 8
- Service tickets: 9
- Customer correspondence: 9
- Total source documents: 40

## Products

- HX-240 - Standard Process Pump
- HX-300 - High-Pressure Process Pump
- HX-400 - High-Temperature Heavy-Duty Pump
- HX-520 - Hygienic CIP Pump

## Designed RAG scenarios

The corpus intentionally includes:
1. Simple single-document lookups
2. Questions requiring evidence from multiple documents
3. Historical proposal precedent
4. Field-service troubleshooting knowledge
5. Customer email context
6. A superseded product document to test version filtering
7. Questions where the correct answer is "insufficient evidence / escalate"
8. Access metadata for future RBAC filtering

## Metadata

`metadata/corpus_manifest.csv` contains document type, product, customer, status, version, effective date and intended access scope.

`metadata/eval_questions.json` contains 10 ground-truth questions for retrieval and grounded-answer evaluation.

All names, customers, email addresses and facts are fictional.
