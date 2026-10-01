import assert from "node:assert/strict";
import test from "node:test";
import { compareGalleryBpm, compareGalleryHighestConstant, highestChartConstant, numericFacetSortValue } from "../src/lib/gallery-sort.js";

type Card = Parameters<typeof compareGalleryBpm>[0];

function card(displayTitle: string, bpm?: string[], constant?: string): Card {
  return {
    displayTitle,
    ...(bpm ? { facets: { bpm } } : {}),
    ...(constant ? { charts: constant.split(",").map((value) => ({ constant: value })) } : {}),
  };
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Number(value.toFixed(6));
}

test("BPM ranges weigh their average instead of their maximum", () => {
  assert.equal(round(numericFacetSortValue(card("range", ["45~158"]), "bpm")), 101.5);
  assert.equal(round(numericFacetSortValue(card("fixed", ["222.222"]), "bpm")), 222.222);
  assert.equal(round(numericFacetSortValue(card("spaced", ["191.919 ~ 232.323"]), "bpm")), 212.121);
  assert.equal(round(numericFacetSortValue(card("ranged decimal", ["77.7-155.4"]), "bpm")), 116.55);
  assert.equal(numericFacetSortValue(card("no number", ["??"]), "bpm"), undefined);
  assert.equal(numericFacetSortValue(card("missing"), "bpm"), undefined);
});

test("BPM sorting is monotonic in both directions for generated range values", () => {
  const cards = [
    card("Fast fixed", ["522"]),
    card("Range high", ["210~500"]),
    card("Range low", ["35~400"]),
    card("Middle", ["267"]),
    card("Narrow range", ["150~160"]),
    card("Slowest", ["96"]),
    card("Unknown", ["?"]),
  ];
  const descending = [...cards].sort((left, right) => compareGalleryBpm(left, right, true)).map((entry) => entry.displayTitle);
  const ascending = [...cards].sort((left, right) => compareGalleryBpm(left, right, false)).map((entry) => entry.displayTitle);
  assert.deepEqual(descending, ["Fast fixed", "Range high", "Middle", "Range low", "Narrow range", "Slowest", "Unknown"]);
  assert.deepEqual(ascending, ["Slowest", "Narrow range", "Range low", "Middle", "Range high", "Fast fixed", "Unknown"]);
});

test("cards without BPM sort last in both directions", () => {
  const withBpm = card("Has BPM", ["140"]);
  const withoutBpm = card("No BPM");
  assert.ok(compareGalleryBpm(withBpm, withoutBpm, true) < 0, "descending keeps data-bearing cards first");
  assert.ok(compareGalleryBpm(withBpm, withoutBpm, false) < 0, "ascending keeps data-bearing cards first");
  assert.ok(compareGalleryBpm(withoutBpm, withBpm, true) > 0);
  assert.ok(compareGalleryBpm(withoutBpm, withBpm, false) > 0);
});

test("chart constants sort descending with data-less cards last", () => {
  assert.equal(highestChartConstant(card("Multi", undefined, "3.0,7.8,10.7")), 10.7);
  assert.equal(highestChartConstant(card("None")), undefined);
  const cards = [card("Low", undefined, "1.0"), card("High", undefined, "12.3"), card("Missing")];
  const descending = [...cards].sort((left, right) => compareGalleryHighestConstant(left, right, true)).map((entry) => entry.displayTitle);
  const ascending = [...cards].sort((left, right) => compareGalleryHighestConstant(left, right, false)).map((entry) => entry.displayTitle);
  assert.deepEqual(descending, ["High", "Low", "Missing"]);
  assert.deepEqual(ascending, ["Low", "High", "Missing"]);
});
