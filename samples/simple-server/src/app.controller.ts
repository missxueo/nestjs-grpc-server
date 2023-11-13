import { Controller, Get } from '@nestjs/common';
import { GrpcMethod } from "@nestjs/microservices"
import { GreetRequest, GreetResponse } from "./protos/greet"

@Controller()
export class AppController {
  constructor() {}

  @Get()
  getHello(): string {
    return "hello"
  }

  @GrpcMethod("GreetService", "Hello")
  async hello(req: GreetRequest, metadata: any): Promise<GreetResponse>{
    console.log('hello', req);

    return {
      from: "bill",
      reply: `hello ${req.to}`
    }
  }

  @GrpcMethod("GreetService", "Hi")
  async hi(req: GreetRequest, metadata: any): Promise<GreetResponse>{
    console.log('hi', req);

    return {
      from: "bill",
      reply: `hi ${req.to}`
    }
  }
}
