// Only public, immutable-for-this-session projections. Reuse pending requests
// and parsed data on return; bound retained categories and retry failed loads.
const data = new Map<string, Promise<unknown>>();
export function loadStaticData<T>(url: string): Promise<T> {
  const existing = data.get(url);
  if (existing) {
    data.delete(url);
    data.set(url, existing);
    return existing as Promise<T>;
  }
  const request = fetch(url, { credentials: "omit" }).then(async (response) => {
    if (!response.ok) throw new Error(`Public data failed with ${response.status}`);
    return response.json();
  }).catch((error) => {
    if (data.get(url) === request) data.delete(url);
    throw error;
  });
  data.set(url, request);
  if (data.size > 6) data.delete(data.keys().next().value!);
  return request as Promise<T>;
}
