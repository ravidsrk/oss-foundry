import { seedState } from "./seed.ts";
import type { FactoryState, TaskPacket } from "./types.ts";

/** The Wave 1 packet the committed seed records. Status moves; the id does not. */
export const WAVE1_PACKET_ID = "pkt_ColeMurray_background-agents_1476";

export function wave1Packet(state: FactoryState = seedState()): TaskPacket {
  const packet = state.packets.find((p) => p.id === WAVE1_PACKET_ID);
  if (!packet) throw new Error(`seed is missing ${WAVE1_PACKET_ID}`);
  return packet;
}

/**
 * Rewind the Wave 1 packet to `submitted` + an open PR. Reducer tests that start from contact
 * need this after issue #109 absorbed the live close into the seed.
 */
export function asOpenSubmitted(packet: TaskPacket): TaskPacket {
  return {
    ...packet,
    status: "submitted",
    station: "follow-up",
    prMeta: packet.prMeta
      ? { ...packet.prMeta, state: "open", merged: false, humanReview: undefined }
      : packet.prMeta,
  };
}

export function withOpenSubmittedWave1(state: FactoryState = seedState()): FactoryState {
  return {
    ...state,
    packets: state.packets.map((p) => (p.id === WAVE1_PACKET_ID ? asOpenSubmitted(p) : p)),
    // Rewind the scorecard write applyPrSync made on the open→closed transition, so reducer
    // tests that close this packet still see a first close (issue #109).
    scorecard: state.scorecard.map((row) =>
      row.repoId === "ColeMurray/background-agents"
        ? { ...row, closedUnmerged: 0, noReview: 0, lastTouch: "2026-08-28" }
        : row,
    ),
  };
}
