import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Kafka, Partitioners } from 'kafkajs';

const TOPIC = 'treasury.program-capacity-updated.v1';

async function main() {
  const [
    programExternalRef = 'PROGRAM-ABC',
    totalLimitMinor = '1500000001',
    currency = 'USD',
    currencyExponent = '2',
    treasuryVersion = String(Date.now()),
  ] = process.argv.slice(2);

  const message = {
    messageId: randomUUID(),
    type: 'PROGRAM_CAPACITY_UPDATED',
    programExternalRef,
    treasuryVersion: Number(treasuryVersion),
    occurredAt: new Date().toISOString(),
    payload: {
      currency,
      currencyExponent: Number(currencyExponent),
      totalLimitMinor: Number(totalLimitMinor),
    },
  };

  const kafka = new Kafka({
    clientId: process.env.KAFKA_CLIENT_ID ?? 'capacity-service-producer',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  });
  const producer = kafka.producer({
    createPartitioner: Partitioners.LegacyPartitioner,
  });
  await producer.connect();
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{ key: programExternalRef, value: JSON.stringify(message) }],
    });
    console.log(
      'Sent PROGRAM_CAPACITY_UPDATED:',
      JSON.stringify(message, null, 2),
    );
  } finally {
    await producer.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to produce message:', error);
  process.exit(1);
});
