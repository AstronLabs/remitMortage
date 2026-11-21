# RemitMortgage developer shortcuts (issue #878).
#
# Intended to be run inside the dev container (.devcontainer/), where Node,
# Rust with the wasm target, PostgreSQL and Redis are already available.
# Run `make` (or `make help`) to list targets.

SHELL := /bin/bash
BACKEND := backend
FRONTEND := frontend
CONTRACTS := contracts

.DEFAULT_GOAL := help

.PHONY: help setup install db-migrate db-seed backend frontend dev test test-backend test-frontend test-contracts upgrade-dry-run build up down logs

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies, prepare and seed the database
	bash .devcontainer/post-create.sh

install: ## Install backend and frontend dependencies
	npm --prefix $(BACKEND) ci
	npm --prefix $(FRONTEND) ci

db-migrate: ## Apply Prisma migrations
	cd $(BACKEND) && npx prisma migrate deploy

db-seed: ## Seed the database
	cd $(BACKEND) && npm run db:seed

backend: ## Run the backend (http://localhost:4000)
	cd $(BACKEND) && npm run dev

frontend: ## Run the frontend (http://localhost:3000)
	cd $(FRONTEND) && npm run dev

dev: ## Run backend and frontend together
	@echo "Starting backend (:4000) and frontend (:3000) — Ctrl-C to stop"
	@trap 'kill 0' INT TERM EXIT; \
	( cd $(BACKEND) && npm run dev ) & \
	( cd $(FRONTEND) && npm run dev ) & \
	wait

test: test-backend test-frontend test-contracts ## Run all tests

test-backend: ## Run backend tests
	cd $(BACKEND) && npm test

test-frontend: ## Run frontend tests
	cd $(FRONTEND) && npm test

test-contracts: ## Run smart-contract tests
	cd $(CONTRACTS) && cargo test

upgrade-dry-run: ## Rehearse a lending-pool upgrade against stored state (BASE_REF=origin/main)
	bash scripts/upgrade-dry-run.sh $(BASE_REF)

build: ## Build backend, frontend and contracts
	cd $(BACKEND) && npm run build
	cd $(FRONTEND) && npm run build
	cd $(CONTRACTS) && cargo build --target wasm32-unknown-unknown --release

up: ## Start the local Stellar sandbox (root docker-compose)
	docker compose up -d

down: ## Stop the local sandbox
	docker compose down

logs: ## Tail sandbox logs
	docker compose logs -f
