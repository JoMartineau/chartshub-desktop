uniform float Amount < ui_label = "Test amount"; ui_type = "slider"; ui_min = 0.0; ui_max = 2.0; ui_step = 0.1; ui_tooltip = "A real compiled ReShade uniform."; > = 1.0;
uniform float2 Shift < ui_label = "Test vector"; ui_type = "drag"; ui_min = -2.0; ui_max = 2.0; ui_step = 0.1; > = float2(0, 0);
uniform int Mode < ui_label = "Test mode"; ui_type = "combo"; ui_items = "Normal\0Alternate\0"; > = 0;
uniform bool Gate < ui_label = "Test gate"; > = true;
uniform float Timer < source = "timer"; >;
texture BackBuffer : COLOR;
sampler BackSampler { Texture = BackBuffer; };
void VS(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD) {
  uv = float2((id << 1) & 2, id & 2);
  position = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
}
float4 PS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
  float4 c = tex2D(BackSampler, uv);
  c.r = Gate ? c.r * Amount : c.r;
  c.gb += Shift * 0.0001 + Mode * 0.0001 + sin(Timer) * 0.00001;
  return c;
}
technique ChartsHubTest < ui_label = "ChartsHub real FX test"; > {
  pass { VertexShader = VS; PixelShader = PS; }
}
