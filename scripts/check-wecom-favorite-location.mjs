import { readFileSync } from "node:fs";

const invalidInput = { status: "invalid_input" };

function normalizeTitle(value) {
  return typeof value === "string" ? value.trim().normalize("NFC") : "";
}

function searchKey(title) {
  return title.normalize("NFKC").toLowerCase().replace(/[\s·・,、()[\]【】]+/gu, "");
}

function isAccountId(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isFavoriteItem(item) {
  return !!item && (item.kind === "location" || item.kind === "other")
    && normalizeTitle(item.title) !== ""
    && (item.address === undefined || typeof item.address === "string");
}

function matchFavoriteLocation(input) {
  const title = normalizeTitle(input?.favorite_title);
  const snapshot = input?.snapshot;
  if (!title || !isAccountId(input?.expected_account_id) || !isAccountId(snapshot?.account_id)) {
    return invalidInput;
  }
  if (snapshot.account_id !== input.expected_account_id) return { status: "account_mismatch" };
  if (snapshot.complete === false) return { status: "incomplete_results" };
  if (snapshot.complete !== true || !Array.isArray(snapshot.items) || !snapshot.items.every(isFavoriteItem)) {
    return invalidInput;
  }

  const locations = snapshot.items.filter(item => item.kind === "location");
  const exact = locations.filter(item => normalizeTitle(item.title) === title);
  const key = searchKey(title);
  const matches = exact.length || !key ? exact : locations.filter(item => searchKey(item.title) === key);
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous" };

  const [location] = matches;
  return { status: "matched", title: location.title, address: location.address ?? "" };
}

let result;
try {
  const raw = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  result = matchFavoriteLocation(JSON.parse(raw));
} catch {
  result = invalidInput;
}

console.log(JSON.stringify(result));
process.exitCode = result.status === "matched" ? 0 : result.status === "invalid_input" ? 2 : 1;
