import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function toDayKey(value: string) {
  const raw = String(value || "").replace(/[^\d]/g, "");
  if (raw.length < 8) return "";
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function cleanCell(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").replace(/^"|"$/g, "").trim();
}

function splitRow(line: string) {
  const text = cleanCell(line);
  if (!text) return [];
  const delimiter = text.includes("\t") ? "\t" : text.includes("|") ? "|" : text.includes(",") ? "," : "";
  if (!delimiter) return [text];
  return text.split(delimiter).map(cleanCell);
}

function safeNumber(value: unknown) {
  const raw = String(value ?? "").replace(/[¥￥,\s]/g, "").replace(/元$/, "");
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.round(num * 100) / 100 : 0;
}

function amountFromCell(value: unknown, header = "") {
  const amount = safeNumber(value);
  if (!amount) return 0;
  return /分|cent|fen/i.test(header) ? Math.round((amount / 100) * 100) / 100 : amount;
}

function cleanLogNo(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, "").slice(0, 64);
}

function parseRecords(text: string) {
  const lines = String(text || "").replace(/\u00a0/g, " ").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.map(splitRow).filter((row) => row.length);
  const headerIndex = rows.findIndex((row) => row.some((cell) => /(交易流水号|对账单流水号|支付交易受理流水号|受理流水号|流水号|log_no|trade_no|交易金额|实收金额|收款金额|到账金额|支付金额|付款人实际支付金额|金额)/i.test(cell)));

  if (headerIndex >= 0) {
    const header = rows[headerIndex];
    const amountIndex = header.findIndex((cell) => /(付款人实际支付金额|实收金额|收款金额|到账金额|交易金额|支付金额|订单金额|金额|trade_amount|payer_amount)/i.test(cell));
    const logIndex = header.findIndex((cell) => /(对账单流水号|支付交易受理流水号|受理流水号|交易流水号|流水号|log_no|trade_no|acc_trade_no|商户订单号|订单号)/i.test(cell));
    const statusIndex = header.findIndex((cell) => /(状态|交易状态|支付状态|trade_status)/i.test(cell));
    const timeIndex = header.findIndex((cell) => /(交易时间|完成时间|支付时间|到账时间|trade_time)/i.test(cell));
    if (amountIndex >= 0) {
      return rows.slice(headerIndex + 1).map((row) => {
        const status = statusIndex >= 0 ? row[statusIndex] : "";
        if (/(失败|退款|撤销|关闭|取消|FAILURE)/i.test(status)) return null;
        const amount = amountFromCell(row[amountIndex], header[amountIndex]);
        if (!amount) return null;
        return {
          amount,
          logNo: logIndex >= 0 ? cleanLogNo(row[logIndex]) : "",
          status,
          tradeTime: timeIndex >= 0 ? row[timeIndex] : "",
        };
      }).filter(Boolean);
    }
  }

  return lines.map((line) => {
    const cleaned = line.replace(/,/g, "");
    const amountMatch = cleaned.match(/[¥￥]\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*元/) || cleaned.match(/(?:^|[^\d])(\d{1,7}(?:\.\d{1,2})?)(?=[^\d]|$)/);
    const amount = safeNumber(amountMatch && (amountMatch[1] || amountMatch[2] || amountMatch[0]));
    if (!amount) return null;
    const logMatch = cleaned.match(/\b([A-Za-z0-9]{12,64})\b/);
    return { amount, logNo: logMatch ? cleanLogNo(logMatch[1]) : "", status: "", tradeTime: "" };
  }).filter(Boolean);
}

function mergeRecords(baseRecords: any[], incomingRecords: any[]) {
  const map = new Map<string, any>();
  [...(Array.isArray(baseRecords) ? baseRecords : []), ...incomingRecords].forEach((record) => {
    const amount = safeNumber(record.amount);
    if (!amount) return;
    const logNo = cleanLogNo(record.logNo || record.log_no || record.tradeNo || record.trade_no);
    const key = logNo || `${amount}|${record.tradeTime || record.trade_time || ""}|${record.status || ""}`;
    map.set(key, { amount, logNo, status: record.status || record.tradeStatus || "", tradeTime: record.tradeTime || record.trade_time || "" });
  });
  return Array.from(map.values());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const expectedToken = Deno.env.get("LAKALA_CALLBACK_TOKEN") || "";
  if (expectedToken && url.searchParams.get("token") !== expectedToken) return jsonResponse({ error: "Invalid callback token" }, 401);

  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const applyOrderNo = cleanCell(body.applyOrderNo || body.apply_order_no || url.searchParams.get("applyOrderNo") || "");
  const downloadUrl = cleanCell(body.downloadUrl || body.download_url || url.searchParams.get("downloadUrl") || "");
  const day = toDayKey(url.searchParams.get("date") || applyOrderNo.slice(2, 10));

  if (!day) return jsonResponse({ error: "Missing reconciliation date" }, 400);
  if (!downloadUrl) return jsonResponse({ error: "Missing downloadUrl" }, 400);

  const fileResponse = await fetch(downloadUrl);
  if (!fileResponse.ok) return jsonResponse({ error: `Download failed: ${fileResponse.status}` }, 502);

  const buffer = await fileResponse.arrayBuffer();
  const text = new TextDecoder("utf-8").decode(buffer);
  const records = parseRecords(text);
  const amounts = records.map((record: any) => record.amount);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Missing Supabase service role configuration" }, 500);

  const table = Deno.env.get("SALES_STATE_TABLE") || "sales_dashboard_state";
  const stateId = Deno.env.get("SALES_STATE_ID") || "yuanpeng_a1";
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: row, error: readError } = await supabase.from(table).select("data").eq("id", stateId).maybeSingle();
  if (readError) return jsonResponse({ error: readError.message }, 500);

  const state = row?.data && typeof row.data === "object" ? row.data : {};
  state.reconciliations = state.reconciliations || {};
  state.meta = state.meta || {};
  state.meta.reconciliations = state.meta.reconciliations || {};

  const item = state.reconciliations[day] || { date: day, amounts: [], providers: {}, updatedAt: "" };
  item.providers = item.providers || {};
  const existing = item.providers.lakala || { records: [], amounts: [] };
  const mergedRecords = mergeRecords(existing.records || [], records);
  item.providers.lakala = {
    amounts: mergedRecords.map((record) => record.amount),
    records: mergedRecords,
    updatedAt: new Date().toISOString(),
    applyOrderNo,
    downloadUrl,
  };
  item.updatedAt = item.providers.lakala.updatedAt;
  state.reconciliations[day] = item;
  state.meta.reconciliations[`lakala:${day}`] = item.updatedAt;

  const { error: writeError } = await supabase.from(table).upsert({ id: stateId, data: state, updated_at: new Date().toISOString() });
  if (writeError) return jsonResponse({ error: writeError.message }, 500);

  return jsonResponse({
    ok: true,
    day,
    applyOrderNo,
    recordCount: records.length,
    mergedCount: mergedRecords.length,
    amountTotal: amounts.reduce((sum: number, amount: number) => sum + amount, 0),
  });
});
