#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js (https://nodejs.org/) and try again."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed. Install Node.js (https://nodejs.org/), which includes npm, and try again."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
else
  echo ".env already exists, skipping"
fi

echo "Installing dependencies..."
npm install

echo "Starting docker compose services..."
docker compose up -d postgres redpanda redpanda-console

echo "Waiting for postgres to become ready..."
until docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do
  sleep 1
done

echo "Running migrations..."
npm run migrate:deploy

echo "Running seeds..."
npm run seed

echo "Starting app service..."
docker compose up -d app

echo "Fetching program id..."
PROGRAM_ID=$(docker compose exec -T postgres psql -U postgres -d capacity -t -A -c "SELECT id FROM programs LIMIT 1;" | tr -d '[:space:]')

echo "Generating dev JWT token..."
DEV_TOKEN=$(npm run --silent token:dev)

echo "\n***********"
echo "\nServer runs on http://localhost:3000/docs"
echo "\nDev JWT token is:\n${DEV_TOKEN}"
echo "\nCurrent program id is:\n${PROGRAM_ID}"
echo "\n***********\n"