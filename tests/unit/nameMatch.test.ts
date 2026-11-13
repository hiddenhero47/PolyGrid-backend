import { normalizeNamePart, namesMatch, splitFullName } from "../../src/helpers/nameMatch";

describe("normalizeNamePart", () => {
  it("lowercases and strips anything that isn't a letter", () => {
    expect(normalizeNamePart(" Ada-   ")).toBe("ada");
    expect(normalizeNamePart("O'Brien")).toBe("obrien");
  });
});

describe("namesMatch", () => {
  it("matches case/whitespace-insensitively", () => {
    expect(namesMatch({ firstName: " ada ", lastName: "OKAFOR" }, { firstName: "Ada", lastName: "okafor" })).toBe(
      true,
    );
  });

  it("fails on a genuine difference in either part", () => {
    expect(namesMatch({ firstName: "Ada", lastName: "Okafor" }, { firstName: "Chidi", lastName: "Okafor" })).toBe(
      false,
    );
    expect(namesMatch({ firstName: "Ada", lastName: "Okafor" }, { firstName: "Ada", lastName: "Eze" })).toBe(false);
  });
});

describe("splitFullName", () => {
  it("splits on the first word, joining the rest as the last name", () => {
    expect(splitFullName("Chinedu Okafor")).toEqual({ firstName: "Chinedu", lastName: "Okafor" });
    expect(splitFullName("Mary Jane Watson")).toEqual({ firstName: "Mary", lastName: "Jane Watson" });
  });

  it("uses the single word as both first and last name when there's only one", () => {
    expect(splitFullName("Cher")).toEqual({ firstName: "Cher", lastName: "Cher" });
  });

  it("trims surrounding whitespace and collapses internal whitespace", () => {
    expect(splitFullName("  Chinedu   Okafor  ")).toEqual({ firstName: "Chinedu", lastName: "Okafor" });
  });
});
