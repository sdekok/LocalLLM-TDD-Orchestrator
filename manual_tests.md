# Manual Test Scenarios - Lens-Powered Analyzer

Follow these steps to verify that the `TypeScriptAnalyzer` correctly leverages the `pi-lens` index when available.

## Scenario 1: Lens Index Detection
1.  **Ensure Lens has indexed the project**:
    ```bash
    # This should create .pi-lens/index.json
    pi-lens index
    ```
2.  **Verify index existence**:
    ```bash
    ls -l .pi-lens/index.json
    ```
3.  **Run analysis**:
    ```bash
    npm run build
    node dist/main.js analyze
    ```
4.  **Check Output**:
    - Open `.tdd-workflow/analysis/typescript-analysis.json`.
    - Verify that exported symbols now contain a `stateMatrix` property (an array of arrays of numbers).
    - Verify that `jsdoc`, `line` numbers, and `dependencyGraph` are still correctly populated.

## Scenario 2: Fail-safe Fallback
1.  **Remove Lens index**:
    ```bash
    rm .pi-lens/index.json
    ```
2.  **Run analysis**:
    ```bash
    node dist/main.js analyze
    ```
3.  **Check Output**:
    - Verify that calculation still completes successfully.
    - Verify that `stateMatrix` is **absent** (or null) from the exported symbols, but all other data is present.

## Scenario 3: Structural Intelligence (Advisory)
1.  **Create a structural duplicate**:
    - Add a function in `src/utils/dummy.ts` that is a copy-paste of a function in `src/utils/logger.ts`.
2.  **Run Lens indexing**:
    ```bash
    pi-lens index
    ```
3.  **Run analysis**:
    ```bash
    node dist/main.js analyze
    ```
4.  **Verify**:
    - Check the `stateMatrix` for both functions in the analysis JSON. They should be identical or very similar.
