import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getStorage, resetStorage } from "./index.ts";
import { DiskStorage } from "./disk.ts";
import { S3Storage } from "./s3.ts";

// Mock S3Storage so we don't need real AWS credentials
vi.mock("./s3.ts", () => {
  class MockS3Storage {
    put = vi.fn();
    get = vi.fn();
    delete = vi.fn();
  }
  return { S3Storage: MockS3Storage };
});

describe("Storage index", () => {
  beforeEach(() => {
    resetStorage();
    delete process.env.STORAGE_BACKEND;
  });

  afterEach(() => {
    resetStorage();
    delete process.env.STORAGE_BACKEND;
  });

  describe("getStorage", () => {
    it("should return DiskStorage by default", () => {
      const storage = getStorage();
      expect(storage).toBeInstanceOf(DiskStorage);
    });

    it("should return DiskStorage when STORAGE_BACKEND is 'disk'", () => {
      process.env.STORAGE_BACKEND = "disk";
      const storage = getStorage();
      expect(storage).toBeInstanceOf(DiskStorage);
    });

    it("should return S3Storage when STORAGE_BACKEND is 's3'", () => {
      process.env.STORAGE_BACKEND = "s3";
      const storage = getStorage();
      expect(storage).toBeInstanceOf(S3Storage);
    });

    it("should default to disk for invalid STORAGE_BACKEND values", () => {
      process.env.STORAGE_BACKEND = "invalid";
      const storage = getStorage();
      expect(storage).toBeInstanceOf(DiskStorage);
    });

    it("should return the same singleton instance on subsequent calls", () => {
      const storage1 = getStorage();
      const storage2 = getStorage();
      expect(storage1).toBe(storage2);
    });
  });

  describe("resetStorage", () => {
    it("should clear the singleton so a new instance is created", () => {
      const storage1 = getStorage();
      resetStorage();
      const storage2 = getStorage();
      expect(storage1).not.toBe(storage2);
    });
  });
});
