# claude-code-other-llms
Claude Code adaptation for use with other LLM models such as OpenAI

## Usage

1. Install Anthropic Claude Code using NPM:
   ```shell
   npm install -g @anthropic-ai/claude-code
   ```
2. Clone this repo:
   ```shell
   git clone https://github.com/devops-click/claude-code-other-llms.git
   ```
3. Install dependencies:
   ```shell
   cd claude-code-other-llms/
   npm install
   ```
4. Export environment variables with your OpenAI API Key (or fill the .env file):
   ```shell
   export OPENAI_API_KEY=""
   export OPENAI_MODEL="" # OPTIONAL - defaults to "o3-mini"
   ```
5. Start the `app.mjs` application:
   Use `--output_fallback_to_console` to output fallback messages to the console if needed.
   ```shell
   node app.mjs
   ```
6. Set additional environment variables:
   ```shell
   export DISABLE_PROMPT_CACHING=1
   export ANTHROPIC_AUTH_TOKEN="any"
   export ANTHROPIC_BASE_URL="http://localhost:3456"
   ```
7. Execute Claude Code:
   ```shell
   claude
   ```
8. Be happy ;)

## Docker Usage

To run the app in a temporary Docker container, ensure Docker is installed and your environment variables (especially OPENAI_API_KEY) are set. Then execute:

```shell
./run_app_docker.sh [temp]
```

The script will:
- Source environment variables from a .env file (if present)
- Set up required parameters
- Launch a Docker container mounting the repo, installing dependencies, and running the app

## Version Control

Call `scripts/version_bump` with the arguments [`major`|`minor`|`patch` (default)] to automatically update the version in `VERSION` and `package.json`. For example:
   ```shell
   scripts/version_bump minor
   # increases version by one for the minor version
   ```
