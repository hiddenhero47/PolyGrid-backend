export default async function globalTeardown(): Promise<void> {
  if (global.__MONGO_REPLSET__) {
    await global.__MONGO_REPLSET__.stop();
  }
}
