import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type, x-supabase-api-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const allowedRoles = new Set(["admin", "manager", "cashier", "inventory_officer"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requiredText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new RequestError(400, `${label} is required and must be no more than ${maxLength} characters.`);
  }
  return value.trim();
}

function parseRole(value: unknown) {
  if (typeof value !== "string" || !allowedRoles.has(value)) {
    throw new RequestError(400, "Choose a valid team member role.");
  }
  return value;
}

async function validateBranch(service: ReturnType<typeof createClient>, branchId: unknown, organizationId: string) {
  if (branchId === null || branchId === undefined || branchId === "") return null;
  if (typeof branchId !== "string" || !uuidPattern.test(branchId)) {
    throw new RequestError(400, "Choose a valid branch.");
  }
  const { data, error } = await service.from("branches")
    .select("id")
    .eq("id", branchId)
    .eq("organization_id", organizationId)
    .eq("active", true)
    .maybeSingle();
  if (error) throw new RequestError(500, error.message);
  if (!data) throw new RequestError(400, "That branch is not active in your organization.");
  return data.id as string;
}

async function requireMember(service: ReturnType<typeof createClient>, userId: unknown, organizationId: string) {
  if (typeof userId !== "string" || !uuidPattern.test(userId)) {
    throw new RequestError(400, "Choose a valid team member.");
  }
  const { data, error } = await service.from("profiles")
    .select("id, role, organization_id")
    .eq("id", userId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new RequestError(500, error.message);
  if (!data) throw new RequestError(404, "That team member is not in your organization.");
  return data;
}

async function ensureAnotherAdmin(service: ReturnType<typeof createClient>, organizationId: string) {
  const { count, error } = await service.from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("role", "admin");
  if (error) throw new RequestError(500, error.message);
  if ((count || 0) <= 1) throw new RequestError(400, "Promote another administrator before removing or demoting this one.");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anonKey || !serviceKey) {
      throw new RequestError(500, "Team management is not configured on the server.");
    }

    const authorization = request.headers.get("Authorization");
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new RequestError(401, "Sign in to manage team members.");

    const callerClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: authError } = await callerClient.auth.getUser(token);
    if (authError || !user) throw new RequestError(401, "Your session is invalid or has expired.");

    const service = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: callerProfile, error: profileError } = await service.from("profiles")
      .select("organization_id, role")
      .eq("id", user.id)
      .maybeSingle();
    if (profileError) throw new RequestError(500, profileError.message);
    if (!callerProfile || callerProfile.role !== "admin") {
      throw new RequestError(403, "Only an administrator can manage team members.");
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      throw new RequestError(400, "Request body must be valid JSON.");
    }

    if (body.action === "list") {
      const { data: members, error: membersError } = await service.from("profiles")
        .select("id, full_name, email, role, branch_id")
        .eq("organization_id", callerProfile.organization_id)
        .order("full_name");
      if (membersError) throw new RequestError(500, membersError.message);

      const authUsers = new Map<string, { email_confirmed_at: string | null }>();
      for (let page = 1; ; page += 1) {
        const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new RequestError(500, error.message);
        for (const authUser of data.users) {
          authUsers.set(authUser.id, { email_confirmed_at: authUser.email_confirmed_at || null });
        }
        if (data.users.length < 1000) break;
      }

      return json(200, {
        team: (members || []).map((member) => ({
          ...member,
          status: authUsers.get(member.id)?.email_confirmed_at ? "active" : "invited",
        })),
      });
    }

    if (body.action === "invite") {
      const fullName = requiredText(body.fullName, "Full name", 120);
      const email = requiredText(body.email, "Email address", 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new RequestError(400, "Enter a valid email address.");
      }
      const password = typeof body.password === "string" ? body.password : "";
      if (password.length < 8) {
        throw new RequestError(400, "Use at least 8 characters for the staff password.");
      }
      const role = parseRole(body.role);
      const branchId = await validateBranch(service, body.branchId, callerProfile.organization_id);
      if (role !== "admin" && !branchId) {
        throw new RequestError(400, "Assign a branch before inviting this team member.");
      }
      const invitationToken = crypto.randomUUID();
      const { error: inviteInsertError } = await service.from("team_invites").insert({
        email,
        invitation_token: invitationToken,
        organization_id: callerProfile.organization_id,
        branch_id: branchId,
        full_name: fullName,
        role,
      });
      if (inviteInsertError) throw new RequestError(409, inviteInsertError.message);

      const { error: invitationError } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        data: {
          full_name: fullName,
          team_invite_token: invitationToken,
          staff_password_set: true,
        },
      });
      if (invitationError) {
        const { error: cleanupError } = await service.from("team_invites").delete().eq("email", email);
        if (cleanupError) {
          throw new RequestError(500, `${invitationError.message} Invitation cleanup failed: ${cleanupError.message}`);
        }
        throw new RequestError(400, invitationError.message);
      }
      return json(200, { success: true });
    }

    if (body.action === "assign-branch") {
      const member = await requireMember(service, body.userId, callerProfile.organization_id);
      const branchId = await validateBranch(service, body.branchId, callerProfile.organization_id);
      if (member.role !== "admin" && !branchId) {
        throw new RequestError(400, "A team member must have an assigned branch.");
      }
      const { error } = await service.from("profiles").update({ branch_id: branchId })
        .eq("id", member.id)
        .eq("organization_id", callerProfile.organization_id);
      if (error) throw new RequestError(500, error.message);
      return json(200, { success: true });
    }

    if (body.action === "update") {
      const member = await requireMember(service, body.userId, callerProfile.organization_id);
      const fullName = requiredText(body.fullName, "Full name", 120);
      const role = parseRole(body.role);
      if (member.id === user.id && role !== "admin") {
        throw new RequestError(400, "You cannot remove your own administrator access.");
      }
      if (member.role === "admin" && role !== "admin") {
        await ensureAnotherAdmin(service, callerProfile.organization_id);
      }
      const branchId = await validateBranch(service, body.branchId, callerProfile.organization_id);
      if (role !== "admin" && !branchId) {
        throw new RequestError(400, "Assign a branch before saving this team member.");
      }
      const { error } = await service.from("profiles").update({
        full_name: fullName,
        role,
        branch_id: branchId,
      }).eq("id", member.id).eq("organization_id", callerProfile.organization_id);
      if (error) throw new RequestError(500, error.message);
      return json(200, { success: true });
    }

    if (body.action === "remove") {
      const member = await requireMember(service, body.userId, callerProfile.organization_id);
      if (member.id === user.id) throw new RequestError(400, "You cannot remove your own account.");
      if (member.role === "admin") await ensureAnotherAdmin(service, callerProfile.organization_id);
      const { error } = await service.auth.admin.deleteUser(member.id);
      if (error) throw new RequestError(500, error.message);
      return json(200, { success: true });
    }

    throw new RequestError(400, "Choose a supported team management action.");
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 500;
    console.error("Team management request failed:", error);
    return json(status, { error: error instanceof Error ? error.message : "The request failed." });
  }
});
