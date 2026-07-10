const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type VerifyTransaction = {
  id?: string;
  logNo?: string;
  amount?: number;
  type?: string;
  personId?: string;
  personName?: string;
  customerName?: string;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function formatReqTime(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function yuanFromFen(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return 0;
  return Math.round((Number(raw) / 100) * 100) / 100;
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const endpoint = Deno.env.get("LAKALA_QUERY_URL") || "https://s2.lakala.com/api/v3/searcher/base_core/trans_query";
  const merchantNo = Deno.env.get("LAKALA_MERCHANT_NO") || "";
  const termNo = Deno.env.get("LAKALA_TERM_NO") || "";
  const extraHeaders = parseHeaders();

  if (!merchantNo) {
    return jsonResponse({ error: "Missing Supabase secret: LAKALA_MERCHANT_NO" }, 500);
  }

  const payload = await req.json().catch(() => ({}));
  const transactions: VerifyTransaction[] = Array.isArray(payload.transactions) ? payload.transactions : [];
  const targets = transactions
    .map((tx) => ({ ...tx, logNo: String(tx.logNo || "").trim() }))
    .filter((tx) => tx.logNo);

  if (!targets.length) return jsonResponse({ records: [] });

  const records = [];

  for (const tx of targets) {
    const body = {
      req_time: formatReqTime(),
      version: "3.0",
      req_data: {
        merchant_no: merchantNo,
        ...(termNo ? { term_no: termNo } : {}),
        log_no: tx.logNo,
      },
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      let data: any = {};
      try { data = JSON.parse(raw); } catch { data = { raw }; }

      const resp = data.resp_data || data.respData || {};
      const trade = Array.isArray(resp.order_trade_info_list)
        ? resp.order_trade_info_list[0] || {}
        : Array.isArray(resp.orderTradeInfoList)
          ? resp.orderTradeInfoList[0] || {}
          : {};

      records.push({
        id: tx.id || "",
        logNo: tx.logNo,
        amount: yuanFromFen(trade.payer_amount || trade.trade_amount || resp.total_amount),
        payer_amount: trade.payer_amount || "",
        trade_amount: trade.trade_amount || resp.total_amount || "",
        status: trade.trade_status || data.code || "",
        tradeTime: trade.trade_time || "",
        code: data.code || String(response.status),
        message: data.msg || data.message || "",
        ok: response.ok && (!data.code || data.code === "000000"),
      });
    } catch (error) {
      records.push({
        id: tx.id || "",
        logNo: tx.logNo,
        amount: 0,
        status: "ERROR",
        code: "EDGE_ERROR",
        message: error instanceof Error ? error.message : String(error),
        ok: false,
      });
    }
  }

  return jsonResponse({ records });
});
