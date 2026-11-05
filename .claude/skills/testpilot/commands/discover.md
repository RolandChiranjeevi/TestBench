# TestPilot: discover

Discover a target and propose a test scope.

Input:
- target URL (required)
- optional context: feature, user goal, release, known risks

Steps:
1. Validate the target URL.
2. Fetch the page and identify:
   - page purpose
   - primary user flows
   - visible interactive elements
   - forms, navigation, authentication hints
   - obvious risks
3. Propose a scope with:
   - in-scope flows
   - out-of-scope areas
   - proposed checks
   - required credentials or test data
4. Stop and ask for approval.

Do not run tests or modify anything before explicit approval.
