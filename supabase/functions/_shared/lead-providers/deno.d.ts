declare namespace Deno {
  const env: {
    get(key: string): string | undefined;
  };
  
  function serve(handler: (req: Request) => Response | Promise<Response>): void;
}