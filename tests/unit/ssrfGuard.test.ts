import http from "http";
import { assertPublicHttpUrl } from "../../src/helpers/ssrfGuard";

describe("assertPublicHttpUrl", () => {
  it("allows a plain public https URL", async () => {
    await expect(assertPublicHttpUrl("https://example.com/avatar.png")).resolves.toBeUndefined();
  });

  it("rejects a non-http(s) protocol", async () => {
    await expect(assertPublicHttpUrl("ftp://example.com/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
  });

  it("rejects localhost and loopback literals", async () => {
    await expect(assertPublicHttpUrl("http://localhost/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://127.0.0.1/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://[::1]/x")).rejects.toThrow();
  });

  it("rejects RFC1918 private ranges and link-local/cloud-metadata", async () => {
    await expect(assertPublicHttpUrl("http://10.0.5.2/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://172.16.0.5/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://192.168.1.1/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
  });

  it("rejects a hostname that resolves to a private IP, not just a private literal", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1.nip.io/x")).rejects.toThrow();
  });

  it("never actually connects once blocked — a loopback listener is never hit", async () => {
    let hit = false;
    const server = http.createServer(() => {
      hit = true;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    await expect(assertPublicHttpUrl(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(hit).toBe(false);

    await new Promise((resolve) => server.close(resolve));
  });
});
