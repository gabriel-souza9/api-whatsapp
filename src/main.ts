import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'dotenv/config';
import { AppModule } from './app.module';

function suppressLibsignalConsoleNoise() {
  const skip = (args: unknown[]) => {
    const msg = args[0];
    return (
      typeof msg === 'string' &&
      (msg.startsWith('Closing session:') ||
        msg.startsWith('Opening session:') ||
        msg === 'Session already closed' ||
        msg === 'Session already open')
    );
  };

  for (const method of ['info', 'warn'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (skip(args)) return;
      original(...args);
    };
  }
}

suppressLibsignalConsoleNoise();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.RMQ,
    options: {
      urls: [process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672'],
      queue: process.env.RABBITMQ_QUEUE ?? 'whatsapp.notify',
      queueOptions: { durable: true },
    },
  });

  const config = new DocumentBuilder()
    .setTitle('API WhatsApp')
    .setDescription('API de WhatsApp (Baileys) para o sistema de pedidos')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  await app.startAllMicroservices();
  await app.listen(process.env.PORT ?? 3002);
}
bootstrap();
