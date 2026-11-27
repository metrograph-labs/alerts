import { describe, expect, it } from "vitest";
import { externalNotificationOf, nodeConfigProblems, type BedNodeConfig } from "./node-config.ts";

const CONFIG: BedNodeConfig = {
  node: "bed-node",
  siren: { pin: 13, activeHigh: true, outputMs: 1_000, nagTimeoutS: 600 },
  button: { pin: 0, pullUp: true },
  channel: { name: "home-alarm", keyName: "MESH_CHANNEL_KEY" },
  beatMs: 60_000,
};

describe("nodeConfigProblems", () => {
  it("gives no problem for good settings", () => {
    expect(nodeConfigProblems(CONFIG)).toEqual([]);
    const { beatMs: _beatMs, ...noBeat } = CONFIG;
    expect(nodeConfigProblems(noBeat)).toEqual([]);
  });

  it("names each bad field, and not its value", () => {
    const bad: BedNodeConfig = {
      node: "Bed Node",
      siren: { pin: 49, activeHigh: true, outputMs: 0, nagTimeoutS: 1.5 },
      button: { pin: -1, pullUp: true },
      channel: { name: "a name that is long", keyName: "1PG8Wq+3kQ==" },
      beatMs: 1_000,
    };
    const problems = nodeConfigProblems(bad);
    expect(problems).toHaveLength(8);
    expect(problems.join(" ")).not.toContain("1PG8Wq");
    expect(problems.join(" ")).not.toContain("Bed Node");
  });

  it("refuses one pin for the siren and the button", () => {
    expect(nodeConfigProblems({ ...CONFIG, button: { pin: 13, pullUp: true } })).toEqual(["The fields siren.pin and button.pin are the same pin."]);
  });

  it("refuses a key value of Meshtastic in the field of the key name", () => {
    expect(nodeConfigProblems({ ...CONFIG, channel: { name: "home-alarm", keyName: "AQ==" } })).toHaveLength(1);
  });
});

describe("externalNotificationOf", () => {
  it("gives the fields of the module: the bell character sounds the siren, and a beat does not", () => {
    expect(externalNotificationOf(CONFIG)).toEqual({ enabled: true, output: 13, active: true, output_ms: 1_000, nag_timeout: 600, alert_bell: true, alert_message: false, use_pwm: false });
  });
});
