# 외부 3D 모델 넣는 곳

`.glb` 또는 `.fbx` 파일을 이 폴더에 넣고 `src/vehicle/models.ts` 의 `MODELS` 에 한 줄 등록하면 상자 모델 대신 그 모델로 그려져요.
파일이 없거나 등록이 안 돼 있으면 상자 모델을 그대로 써요.

## 지금 들어 있는 에셋 (모두 CC0, 출처 표기 불필요)

| 폴더 | 출처 | 쓰는 곳 |
| --- | --- | --- |
| `kenney/` | [Kenney Car Kit 3.1](https://kenney.nl/assets/car-kit) | 교통 승용차·택시·밴·배달차, 라이벌 3대. `Textures/colormap.png` 가 꼭 같이 있어야 해요 |
| `rgsdev/` | [Free Low Poly Vehicles Pack by Rgsdev](https://opengameart.org/content/free-low-poly-vehicles-pack) | 시내·마을·광역버스 (`Bus.fbx`). 차체 색은 차종별로 코드에서 입혀요 |

한국 차종(쏘나타 택시, 에어로시티 버스 등)은 Sketchfab 등에서 로그인 후 받아야 해요. 받은 파일을 여기에 넣고 `MODELS` 의 `taxi`, `city_bus` 항목만 바꾸면 돼요.

## 등록 예시

```ts
export const MODELS: Record<string, ModelDef> = {
  taxi: { file: 'sonata_taxi.glb', length: 4.9, attribution: '작성자, CC-BY 4.0, https://sketchfab.com/...' },
  city_bus: { file: 'aero_city.glb', length: 11, yaw: Math.PI }, // 모델 앞머리가 -Z 를 볼 때
};
```

## 어떤 키를 쓰나

| 키 | 쓰이는 곳 |
| --- | --- |
| `sedan`, `taxi`, `city_bus`, `village_bus`, `express_bus` | 교통 차량 (`src/vehicle/kinds.ts`) |
| `rival_1`, `rival_2`, `rival_3` | 라이벌 다크나이트, 블루스톰, 레드폭스 |
| `car_city`, `car_sprinter`, `car_vista`, `car_phantom` | 차고에서 사는 플레이어 차량 |

## 고를 때 기준

- 포맷: **glb** (Sketchfab 다운로드에서 "glTF" 선택) 또는 **fbx**. `.skp` 는 Blender 변환이 필요해요.
- 폴리곤: 대당 **1~2만 삼각형 이하**, 텍스처 1024px 이하. 교통 차량 37대가 같이 돌아가요.
- 방향: 앞머리가 +Z 를 보는 게 기본. 아니면 `yaw` 로 보정해요 (+X 를 보면 `-Math.PI / 2`).
- 크기는 신경 쓰지 않아도 돼요. `length` 에 맞춰 자동으로 조절돼요.
- 라이선스: CC0 / CC-BY 를 고르고 `attribution` 에 출처를 적어 두세요. 비상업용(NC) 모델은 공개 배포 전에 빼야 해요.
- 상표: 개인 프로젝트에서는 실제 차명·로고를 써도 되지만, 배포할 땐 가상 브랜드로 바꾸는 게 안전해요.

## 참고: 플레이어 차량 모델을 쓰면

- 도색(`paint`) 은 glb 의 재질에는 적용되지 않아요. 모델 자체 색을 써요.
- 바퀴 회전·조향 애니메이션은 상자 모델에만 있어요.
