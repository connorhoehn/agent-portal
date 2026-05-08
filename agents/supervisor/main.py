from bedrock_agentcore.runtime import BedrockAgentCoreApp

app = BedrockAgentCoreApp()


@app.entrypoint()
async def handle(input_text: str, **kwargs) -> dict:
    return {
        "status": "ok",
        "agent": "supervisor",
        "message": f"Received: {input_text}",
        "note": "Phase 3a: Replace with Strands Agent + A2A sub-agent routing",
    }


if __name__ == "__main__":
    app.run()
