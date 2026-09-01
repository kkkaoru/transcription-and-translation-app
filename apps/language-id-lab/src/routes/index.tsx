// Runs with Bun during build and test.
import { createFileRoute } from "@tanstack/react-router";
import { LanguageHarness } from "../language-harness";

export const Route = createFileRoute("/")({ component: LanguageHarness });
