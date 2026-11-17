-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "ingestKey" TEXT NOT NULL,
    "installedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" DATETIME,
    "trackingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "moosendWebsiteId" TEXT,
    "moosendApiKeyEnc" TEXT,
    "itemCodeSource" TEXT NOT NULL DEFAULT 'SKU_OR_VARIANT_ID',
    "customEventsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "webhookPurchaseFallback" BOOLEAN NOT NULL DEFAULT true,
    "checkoutAsAddToOrder" BOOLEAN NOT NULL DEFAULT false,
    "webPixelId" TEXT,
    "pixelStatus" TEXT NOT NULL DEFAULT 'NOT_CONNECTED',
    "pixelError" TEXT,
    "pixelSyncedAt" DATETIME,
    "lastDeliveryAt" DATETIME,
    "lastDeliveryError" TEXT,
    "lastDeliveryErrorAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Visitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "customerId" TEXT,
    "emailEnc" TEXT,
    "emailHash" TEXT,
    "nameEnc" TEXT,
    "identifiedAt" DATETIME,
    "addedItemCodes" TEXT NOT NULL DEFAULT '[]',
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Visitor_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "shopId" TEXT NOT NULL,
    "sourceEventId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("shopId", "sourceEventId"),
    CONSTRAINT "ProcessedEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CheckoutSnapshot" (
    "shopId" TEXT NOT NULL,
    "checkoutToken" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "itemsJson" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("shopId", "checkoutToken"),
    CONSTRAINT "CheckoutSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderTracking" (
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "clientId" TEXT,
    "customerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("shopId", "orderId"),
    CONSTRAINT "OrderTracking_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "visitorKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadEnc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" DATETIME,
    "lastError" TEXT,
    "lastStatus" INTEGER,
    "orderId" TEXT,
    "holdsSequence" BOOLEAN NOT NULL DEFAULT true,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboxEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ComplianceRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "requestId" TEXT,
    "reportEnc" TEXT,
    "summary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplianceRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_ingestKey_key" ON "Shop"("ingestKey");

-- CreateIndex
CREATE INDEX "Visitor_shopId_emailHash_idx" ON "Visitor"("shopId", "emailHash");

-- CreateIndex
CREATE INDEX "Visitor_shopId_customerId_idx" ON "Visitor"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "Visitor_lastSeenAt_idx" ON "Visitor"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Visitor_shopId_clientId_key" ON "Visitor"("shopId", "clientId");

-- CreateIndex
CREATE INDEX "ProcessedEvent_createdAt_idx" ON "ProcessedEvent"("createdAt");

-- CreateIndex
CREATE INDEX "CheckoutSnapshot_updatedAt_idx" ON "CheckoutSnapshot"("updatedAt");

-- CreateIndex
CREATE INDEX "OrderTracking_createdAt_idx" ON "OrderTracking"("createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_shopId_visitorKey_createdAt_idx" ON "OutboxEvent"("shopId", "visitorKey", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_shopId_createdAt_idx" ON "OutboxEvent"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_shopId_orderId_idx" ON "OutboxEvent"("shopId", "orderId");

-- CreateIndex
CREATE INDEX "ComplianceRequest_shopId_createdAt_idx" ON "ComplianceRequest"("shopId", "createdAt");
