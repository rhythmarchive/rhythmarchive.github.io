// One bounded control-plane collection per day. Never list or fetch R2 objects.
import { createHmac } from "node:crypto";
const { ACCOUNT: id, READ_TOKEN: read, WRITE_TOKEN: write } = process.env;
if (!/^[a-f0-9]{32}$/.test(id) || !read || !write)
  throw Error("missing environment");
const base = `/accounts/${id}`,
  now = new Date(),
  iso = now.toISOString(),
  day = iso.slice(0, 10),
  month = day.slice(0, 7) + "-01";
const sample = { observedAt: iso, day, errors: {} };
async function api(path, body, token = read, method = body ? "POST" : "GET") {
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw Error("HTTP " + r.status);
  const j = await r.json();
  if (j.errors?.length || j.success === false)
    throw Error(
      "API " +
        (j.errors?.[0]?.extensions?.code ?? j.errors?.[0]?.code ?? (/permission|authorized|access/i.test(j.errors?.[0]?.message??"") ? "access denied" : /unknown|field|argument/i.test(j.errors?.[0]?.message??"") ? "query field" : "rejected")),
    );
  return j;
}
async function graph(field) {
  const j = await api("/graphql", {
    query: `{viewer{accounts(filter:{accountTag:"${id}"}){rows:${field}}}}`,
  });
  const rows = j.data?.viewer?.accounts?.[0]?.rows;
  if (!rows?.length) throw Error("no samples");
  return rows;
}
const n = (x) => {
  if (!Number.isSafeInteger(x) || x < 0) throw Error("missing counter");
  return x;
};
async function get(key, fn) {
  try {
    return await fn();
  } catch (e) {
    sample.errors[key] = e.message;
    return null;
  }
}
const daily = `datetime_geq:"${day}T00:00:00Z",datetime_lt:"${iso.slice(0, 19)}Z"`;
sample.workers = await get("workers", async () =>
  n(
    (
      await graph(
        `workersInvocationsAdaptive(limit:1,filter:{${daily}}){sum{requests}}`,
      )
    )[0].sum.requests,
  ),
);
sample.d1 = await get("d1", async () => {
  const { rowsRead, rowsWritten } = (
    await graph(
      `d1AnalyticsAdaptiveGroups(limit:1,filter:{${daily}}){sum{rowsRead rowsWritten}}`,
    )
  )[0].sum;
  return { reads: n(rowsRead), writes: n(rowsWritten) };
});
sample.d1Bytes = await get("d1Bytes", async () => {
  const j = await api(base + "/d1/database?per_page=100", null, read);
  if (
    !j.result?.length ||
    j.result.length >= 100 ||
    j.result_info?.total_count > j.result.length
  )
    throw Error("incomplete list");
  let total = 0;
  for (const b of j.result) {
    if (j.result.length > 20) throw Error("inventory cap");
    total += n(
      b.file_size ??
        (await api(base + "/d1/database/" + b.uuid, null, read)).result
          .file_size,
    );
  }
  return total;
});
if (sample.d1Bytes === null) {
  // No directory permission: report observed databases, never claim a verified full inventory.
  sample.d1Bytes = await get('d1StorageAnalytics', async () => {
    const since = new Date(+now-864e5).toISOString().slice(0,19)+'Z';
    const rows = await graph(`d1StorageAdaptiveGroups(limit:100,filter:{datetime_geq:"${since}",datetime_lt:"${iso.slice(0,19)}Z"}){dimensions{databaseId} max{databaseSizeBytes}}`);
    if(rows.length>=100)throw Error('inventory cap');
    sample.d1StorageBasis='observed-peaks';
    return rows.reduce((sum,x)=>sum+n(x.max.databaseSizeBytes),0);
  });
}
const A =
    "ListBuckets PutBucket ListObjects ListObjectsV2 PutObject CopyObject CompleteMultipartUpload CreateMultipartUpload LifecycleStorageTierTransition ListMultipartUploads UploadPart UploadPartCopy ListParts PutBucketEncryption PutBucketCors PutBucketLifecycleConfiguration".split(
      " ",
    ),
  B =
    "HeadBucket HeadObject GetObject UsageSummary GetBucketEncryption GetBucketLocation GetBucketCors GetBucketLifecycleConfiguration".split(
      " ",
    );
sample.ops = await get("ops", async () => {
  const rows = await graph(
    `r2OperationsAdaptiveGroups(limit:200,filter:{date_geq:"${month}",date_leq:"${day}"}){dimensions{actionType} sum{requests}}`,
  );
  if (rows.length >= 200) throw Error("truncated");
  let a = 0,
    b = 0,
    all = 0;
  for (const x of rows) {
    const k = n(x.sum.requests);
    all += k;
    if (A.includes(x.dimensions.actionType)) a += k;
    if (B.includes(x.dimensions.actionType)) b += k;
  }
  return { a, b, all, unclassified: all - a - b };
});
sample.bucket = await get("bucket", async () => {
  const x = (
    await graph(
      `r2StorageAdaptiveGroups(limit:1,orderBy:[datetime_DESC],filter:{bucketName:"rhythm-archive",datetime_geq:"${new Date(+now - 864e5).toISOString().slice(0, 19)}Z"}){dimensions{datetime} max{payloadSize metadataSize}}`,
    )
  )[0];
  if (+now - Date.parse(x.dimensions.datetime) > 864e5) throw Error("stale");
  return {
    at: x.dimensions.datetime,
    bytes: n(x.max.payloadSize) + n(x.max.metadataSize),
  };
});
sample.gbMonth = await get("gbMonth", async () => {
  const rows = await graph(
    `r2StorageAdaptiveGroups(limit:1000,filter:{date_geq:"${month}",date_leq:"${day}"}){dimensions{date bucketName} max{payloadSize metadataSize}}`,
  );
  if (rows.length >= 1000) throw Error("truncated");
  const dates = new Set(rows.map((x) => x.dimensions.date));
  if (dates.size !== now.getUTCDate()) throw Error("missing daily peaks");
  return (
    rows.reduce((s, x) => s + n(x.max.payloadSize) + n(x.max.metadataSize), 0) /
    30e9
  );
});
sample.lastInvoice = await get("billing", async () => {
  const j = await api(
    "/user/billing/history?per_page=20&order=occurred_at&direction=desc",
  );
  const x = j.result
    ?.filter(
      (x) =>
        x.zone?.name === "rhythmarchive.top" &&
        ["charge", "payment"].includes(x.type) &&
        ["paid", "payment", "charge"].includes(x.action) &&
        Number.isFinite(x.amount) &&
        /^[A-Z]{3}$/.test(x.currency) &&
        Number.isFinite(Date.parse(x.occurred_at)),
    )
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))[0];
  if (!x) throw Error("no confirmed charge");
  return { amount: x.amount, currency: x.currency, at: x.occurred_at };
});
// The deployment credential stays on the runner. Provision a purpose-specific secret only on initial setup/rotation.
const key = createHmac("sha256", write)
  .update("rhythm-archive/stats/quota-snapshot/v1/" + id)
  .digest("hex");
async function publish() {
  return fetch(
    "https://api.rhythmarchive.top/v1/admin/operations/quota-snapshot",
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sample),
    },
  );
}
let result = await publish();
if (result.status === 401) {
  await api(
    base + "/workers/scripts/rhythm-archive-stats/secrets",
    { name: "QUOTA_SNAPSHOT_TOKEN", type: "secret_text", text: key },
    write,
    "PUT",
  );
  await new Promise((r) => setTimeout(r, 6000));
  result = await publish();
}
if (!result.ok) throw Error("Snapshot ingestion HTTP " + result.status);
console.log(
  "Sample saved; unavailable sources:",
  Object.entries(sample.errors)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ") || "none",
);
