const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatReqTime(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function compactDate(day: string) {
  return String(day || "").replace(/[^\d]/g, "").slice(0, 8);
}

function parseHeaders() {
  const raw = Deno.env.get("LAKALA_HEADERS_JSON") || "{}";
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function callbackUrl(date: string, applyOrderNo: string) {
  const configured = Deno.env.get("LAKALA_CALLBACK_URL") || "";
  const base = configured || `${Deno.env.get("SUPABASE_URL") || ""}/functions/v1/lakala-recon-callback`;
  const token = Deno.env.get("LAKALA_CALLBACK_TOKEN") || "";
  const url = new URL(base);
  url.searchParams.set("date", date);
  url.searchParams.set("applyOrderNo", applyOrderNo);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const payload = await req.json().catch(() => ({}));
  const date = compactDate(payload.date || payload.day);
  if (!/^\d{8}$/.test(date)) return jsonResponse({ error: "Missing date, expected YYYY-MM-DD" }, 400);

  const merchantNo = Deno.env.get("LAKALA_MERCHANT_NO") || "";
  const termNo = Deno.env.get("LAKALA_TERM_NO") || "";
  const endpoint = Deno.env.get("LAKALA_APPLY_URL") || "https://s2.lakala.com/api/v3/bmmp4/checkFile/apply";
  const extraHeaders = parseHeaders();

  if (!merchantNo) return jsonResponse({ error: "Missing Supabase secret: LAKALA_MERCHANT_NO" }, 500);

  const applyOrderNo = `A1${date}${Date.now().toString(36).toUpperCase()}`.slice(0, 32);
  const reqData = {
    apply_order_no: applyOrderNo,
    merchant_no: merchantNo,
    ...(termNo ? { term_no: termNo } : {}),
    tran_start_date: date,
    tran_start_time: "00:00",
    tran_end_date: date,
    tran_end_time: "23:59",
    call_back_url: callbackUrl(date, applyOrderNo),
  };

  const body = { req_time: formatReqTime(), version: "3.0", req_data: reqData };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let data: any = {};
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    return jsonResponse({
      ok: response.ok && (!data.code || data.code === "000000"),
      apply_order_no: applyOrderNo,
      code: data.code || String(response.status),
      msg: data.msg || data.message || "",
      resp_data: data.resp_data || data.respData || {},
      request: { ...reqData, call_back_url: reqData.call_back_url.replace(/token=[^&]+/, "token=***") },
    }, response.ok ? 200 : response.status);
  } catch (error) {
    return jsonResponse({
      ok: false,
      apply_order_no: applyOrderNo,
      code: "EDGE_ERROR",
      msg: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
