import { Request, Response } from "express";
import { timeWindowGuard } from "../../src/middleware/timeWindowGuard";

const mockReq = () => ({ originalUrl: "/api/deployment/setup" }) as Request;

const mockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
};

describe("timeWindowGuard", () => {
  it("throws immediately on a malformed start date — fails at registration time, not per-request", () => {
    expect(() => timeWindowGuard("not-a-date", 24)).toThrow();
  });

  it("throws immediately on a non-positive hours value", () => {
    expect(() => timeWindowGuard(new Date().toISOString(), 0)).toThrow();
    expect(() => timeWindowGuard(new Date().toISOString(), -5)).toThrow();
  });

  it("opens when now falls inside the configured window", () => {
    const start = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // started 1h ago
    const next = jest.fn();

    timeWindowGuard(start, 24)(mockReq(), mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("closes once the window has elapsed", () => {
    const start = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // started 2 days ago
    const next = jest.fn();
    const res = mockRes();

    timeWindowGuard(start, 24)(mockReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("closes before the window has started", () => {
    const start = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // starts in 1h
    const next = jest.fn();

    timeWindowGuard(start, 24)(mockReq(), mockRes(), next);

    expect(next).not.toHaveBeenCalled();
  });

  it("the same guard instance can be reused across requests with a stable window", () => {
    const start = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const guard = timeWindowGuard(start, 24);

    const firstNext = jest.fn();
    guard(mockReq(), mockRes(), firstNext);
    const secondNext = jest.fn();
    guard(mockReq(), mockRes(), secondNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).toHaveBeenCalledTimes(1);
  });
});
