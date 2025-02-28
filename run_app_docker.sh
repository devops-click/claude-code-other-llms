#!/bin/bash
## Requires OPENAI_API_KEY Environment Variable set or .env file in order to work.
## To start a temporary container, use the argument `temp`

# Source .env if it exists
test -f .env && source .env

# Setup variables
export TEMP_FLAG=${1:-temp}
export OPENAI_MODEL=${OPENAI_MODEL:-"o3-mini"}
export OPENAI_BASE_URL=${OPENAI_BASE_URL:-"https://api.openai.com/v1"}
export DISABLE_PROMPT_CACHING=1
export ANTHROPIC_AUTH_TOKEN="any"
export ANTHROPIC_BASE_URL="http://localhost:3456"

# Check required environment variables
if [ -z "$OPENAI_API_KEY" ]; then
  echo "Error: OPENAI_API_KEY must be set"
  exit 1
fi

# Setup docker container as a temp container
[[ "$TEMP_FLAG" == "temp" ]] && export TEMP_CONTAINER="--rm"

echo -e "\n** Initiating Claude Code Inteceptor Docker container..."
# Run docker container to clone repo, install npm dependencies, and start the app
docker run $TEMP_CONTAINER -d \
  --name claude-code-interceptor \
  -p 3456:3456 \
  -e DISABLE_PROMPT_CACHING="$DISABLE_PROMPT_CACHING" \
  -e ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN" \
  -e ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e OPENAI_MODEL="$OPENAI_MODEL" \
  -e OPENAI_BASE_URL="$OPENAI_BASE_URL" \
  -v "$PWD":/app \
  -w /app \
  node:latest \
  bash -c "npm install -g npm@11.1.0 && npm install && node app.mjs"

## To enable post-processing of the docker container and also the usage without mapping the current directory.
# docker exec claude-code-interceptor bash -c "git clone https://github.com/devops-click/claude-code-other-llms.git && cd claude-code-other-llms && npm install -g npm@11.1.0 && npm install && node app.mjs"
