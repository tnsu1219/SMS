import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedRoles = new Set([
  "admin",
  "manager",
  "cashier",
  "inventory_officer",
]);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function getCorsHeaders(request: Request): Record<string, string> {
  const configuredOrigin = Deno.env.get("ALLOWED_ORIGIN");
  const requestOrigin = request.headers.get("Origin");

  // Set ALLOWED_ORIGIN to the exact deployed frontend origin in production.
  // If it is not configured, "*" is retained for local development only.
  const allowOrigin = configuredOrigin
    ? (requestOrigin === configuredOrigin ? configuredOrigin : configuredOrigin)
    : "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, apikey, x-client-info, content-type, x-supabase-api-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(
  request: Request,
  status: number,
  body: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(request),
      "Content-Type": "application/json",
    },
  });
}

function requiredText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxLength
  ) {
    throw new RequestError(
      400,
      `${label} is required and must be no more than ${maxLength} characters.`,
    );
  }
  return value.trim();
}

function parseRole(value: unknown): string {
  if (typeof value !== "string" || !allowedRoles.has(value)) {
    throw new RequestError(400, "Choose a valid team member role.");
  }
  return value;
}

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(request) });
  }

  if (request.method !== "POST") {
    return json(request, 405, { error: "Method not allowed." });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
